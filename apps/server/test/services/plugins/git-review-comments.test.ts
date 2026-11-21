import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinPluginSource } from "../../../src/services/plugins/builtin-registry.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import { waitForQueuedCommand } from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";
const PLUGIN_ID = "bb--git";
const ALL = { type: "all", mergeBaseBranch: "main" };

interface RpcEnvelope {
  ok: boolean;
  result?: any;
  error?: { code: string; message: string };
}

describe("review comments through the real send path", () => {
  let harness: RunningTestServer;

  beforeEach(async () => {
    harness = await startTestServer();
    harness.pluginService.bindSdk({ baseUrl: harness.baseUrl });
    const entry = await harness.pluginService.install(
      builtinPluginSource("git"),
      { kind: "root" },
    );
    expect(entry.statusDetail ?? "").toBe("");
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.close();
  });

  async function rpc(
    method: string,
    input: Record<string, unknown>,
  ): Promise<RpcEnvelope> {
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/${PLUGIN_ID}/rpc/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    return (await response.json()) as RpcEnvelope;
  }

  function seedThreadInEnvironment() {
    const { host } = seedHostSession(harness.deps, { id: "host-review" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/review-comments",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: "/tmp/review-comments",
      status: "ready",
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "idle",
    });
    return { environment, thread };
  }

  async function saveComment(
    environmentId: string,
    body: string,
    line: number,
  ) {
    const saved = await rpc("addComment", {
      environmentId,
      target: ALL,
      revision: "100644:0a0a0a:100644:b1b1b1",
      anchor: {
        path: "src/session.ts",
        side: "new",
        startLine: line,
        endLine: line + 1,
        lines: [`const a${line} = 1;`, `const b${line} = 2;`],
        contextBefore: [],
        contextAfter: [],
      },
      body,
    });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    return saved.result.comment as { id: string };
  }

  it("resolves the chip into agent-only context, marks the comments Sent for the thread, and does not wait for a machine that does not answer", async () => {
    const { environment, thread } = seedThreadInEnvironment();
    const first = await saveComment(
      environment.id,
      "Why is this not cached?",
      40,
    );
    const second = await saveComment(environment.id, "Rename this", 90);

    const batch = await rpc("createCommentBatch", {
      environmentId: environment.id,
      threadId: thread.id,
    });
    expect(batch.ok).toBe(true);
    expect(batch.result).toMatchObject({
      count: 2,
      label: "2 review comments",
    });

    const startedAt = Date.now();
    await sendThreadMessage(harness.deps, {
      originPluginId: null,
      environment,
      payload: {
        input: [
          {
            type: "text",
            text: "@2 review comments",
            mentions: [
              {
                start: 0,
                end: "@2 review comments".length,
                resource: {
                  kind: "plugin",
                  pluginId: PLUGIN_ID,
                  itemId: `review-comments:${batch.result.batchId}`,
                  label: "2 review comments",
                },
              },
            ],
          },
        ],
        mode: "start",
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      },
      thread,
      trigger: "user",
    });
    expect(Date.now() - startedAt).toBeLessThan(9_000);

    const queued = await waitForQueuedCommand(
      harness,
      (candidate) =>
        candidate.command.type === "thread.start" &&
        candidate.command.threadId === thread.id,
    );
    if (queued.command.type !== "thread.start") {
      throw new Error("Expected a thread.start command");
    }
    const agentOnly = queued.command.input.filter(
      (item) => item.type === "text" && item.visibility === "agent-only",
    );
    expect(agentOnly).toHaveLength(1);
    const text = agentOnly[0]?.type === "text" ? agentOnly[0].text : "";
    expect(text).toContain(`resolved by plugin "${PLUGIN_ID}"`);
    expect(text).toContain(`<review_comments environment="${environment.id}">`);
    expect(text).toContain(`id="${first.id}" path="src/session.ts"`);
    expect(text).toContain('lines="40-41"');
    expect(text).toContain('lines="90-91"');
    expect(text).toContain('placement="unknown"');
    expect(text).toContain("Why is this not cached?");
    expect(text).toContain(
      'bb git comments resolve <id> --note "<what you changed>"',
    );
    expect(queued.command.input[0]).toMatchObject({
      type: "text",
      text: "@2 review comments",
    });

    const states = await rpc("comments", {
      environmentId: environment.id,
      target: ALL,
    });
    expect(states.ok).toBe(true);
    const comments = states.result.comments as Array<{
      id: string;
      state: string;
      sent?: { threadId: string };
    }>;
    expect(comments.map((comment) => comment.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    for (const comment of comments) {
      expect(comment.state).toBe("sent");
      expect(comment.sent?.threadId).toBe(thread.id);
    }
  }, 60_000);

  async function sendWithChips(
    environment: Parameters<typeof sendThreadMessage>[1]["environment"],
    thread: Parameters<typeof sendThreadMessage>[1]["thread"],
    chips: Array<{ batchId: string; label: string }>,
  ) {
    const text = chips.map((chip) => `@${chip.label}`).join(" ");
    let start = 0;
    const mentions = chips.map((chip) => {
      const mention = {
        start,
        end: start + chip.label.length + 1,
        resource: {
          kind: "plugin" as const,
          pluginId: PLUGIN_ID,
          itemId: `review-comments:${chip.batchId}`,
          label: chip.label,
        },
      };
      start += chip.label.length + 2;
      return mention;
    });
    await sendThreadMessage(harness.deps, {
      originPluginId: null,
      environment,
      payload: {
        input: [{ type: "text", text, mentions }],
        mode: "start",
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      },
      thread,
      trigger: "user",
    });
    const queued = await waitForQueuedCommand(
      harness,
      (candidate) =>
        candidate.command.type === "thread.start" &&
        candidate.command.threadId === thread.id,
    );
    if (queued.command.type !== "thread.start") {
      throw new Error("Expected a thread.start command");
    }
    return queued.command.input.flatMap((item) =>
      item.type === "text" && item.visibility === "agent-only"
        ? [item.text]
        : [],
    );
  }

  it("sends the message with a short note when every comment in the chip was resolved first", async () => {
    const { environment, thread } = seedThreadInEnvironment();
    const comment = await saveComment(environment.id, "Done already", 10);
    const batch = await rpc("createCommentBatch", {
      environmentId: environment.id,
      threadId: thread.id,
    });
    await rpc("resolveComment", { id: comment.id, note: "fixed" });

    const agentOnly = await sendWithChips(environment, thread, [
      { batchId: batch.result.batchId, label: "1 review comment" },
    ]);
    expect(agentOnly).toHaveLength(1);
    expect(agentOnly[0]).toContain("already resolved, deleted or delivered");
    expect(agentOnly[0]).not.toContain("<review_comments");
  });

  it("hands each comment to the agent once when two chips cover it", async () => {
    const { environment, thread } = seedThreadInEnvironment();
    const first = await saveComment(environment.id, "First", 10);
    const second = await saveComment(environment.id, "Second", 30);
    const everything = await rpc("createCommentBatch", {
      environmentId: environment.id,
      threadId: thread.id,
    });
    const again = await rpc("createCommentBatch", {
      environmentId: environment.id,
      threadId: thread.id,
    });
    expect(again.result.batchId).toBe(everything.result.batchId);
    const onlyFirst = await rpc("createCommentBatch", {
      environmentId: environment.id,
      threadId: thread.id,
      ids: [first.id],
    });
    expect(onlyFirst.result.batchId).not.toBe(everything.result.batchId);

    const agentOnly = await sendWithChips(environment, thread, [
      { batchId: everything.result.batchId, label: "2 review comments" },
      { batchId: everything.result.batchId, label: "2 review comments" },
      { batchId: onlyFirst.result.batchId, label: "1 review comment" },
    ]);
    const delivered = agentOnly.join("\n");
    expect(delivered.split(`id="${first.id}"`)).toHaveLength(2);
    expect(delivered.split(`id="${second.id}"`)).toHaveLength(2);
  }, 60_000);
});
