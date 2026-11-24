import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootEventHost,
  createEventAutomation,
  createHook,
  githubRequest,
  listEvents,
  listRuns,
  PROJECT_ID,
  readSecretMode,
  settle,
  waitForSpawns,
  type EventTestHost,
} from "./event-test-host.js";
import { webhookAdapter } from "./event-adapters/webhook.js";
import { renderEventPromptBody } from "./event-prompt.js";

const WEBHOOK_PATH = "/webhook";
const DAY_MS = 24 * 60 * 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(
  options: Parameters<typeof bootEventHost>[0] = {},
): Promise<EventTestHost> {
  const state = await bootEventHost(options);
  cleanups.push(() => state.host.harness.dispose());
  return state;
}

function post(state: EventTestHost, hookId: string, init: RequestInit) {
  return state.host.harness.fetchHttp(
    "POST",
    `${WEBHOOK_PATH}?hook=${hookId}`,
    init,
  );
}

function signedString(
  timestamp: string,
  delivery: string,
  event: string,
  body: string,
): string {
  return `${timestamp}\n${delivery}\n${event}\n${body}`;
}

function signed(args: {
  secret: string;
  body: string;
  delivery?: string;
  event?: string;
  signDelivery?: string;
  signEvent?: string;
  timestamp?: number;
}): RequestInit {
  const timestamp = String(args.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", args.secret)
    .update(
      signedString(
        timestamp,
        args.signDelivery ?? args.delivery ?? "",
        args.signEvent ?? args.event ?? "",
        args.body,
      ),
    )
    .digest("hex");
  return {
    method: "POST",
    body: args.body,
    headers: {
      "content-type": "application/json",
      "x-bb-timestamp": timestamp,
      "x-bb-signature": `v1=${signature}`,
      ...(args.event === undefined ? {} : { "x-bb-event": args.event }),
      ...(args.delivery === undefined
        ? {}
        : { "x-bb-delivery": args.delivery }),
    },
  };
}

function count(state: EventTestHost, table: string): number {
  const row = state.host.bb.storage
    .database()
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

describe("hourly cap and dedupe survive delivery-log cleanup", () => {
  it("keeps the cap after more than 100 later deliveries are pruned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
    const state = await boot();
    const { hook, secret } = await createHook(state.host);
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
      trigger: { events: ["match"], maxRunsPerHour: 3 },
    });
    const send = (event: string, delivery: string) =>
      post(state, hook.id, signed({ secret, body: "{}", event, delivery }));

    expect((await send("match", "m1")).status).toBe(202);
    await waitForSpawns(state, 1);
    await send("match", "m2");
    await send("match", "m3");
    for (let batch = 0; batch < 2; batch += 1) {
      for (let index = 0; index < 60; index += 1) {
        await send("other", `o-${batch}-${index}`);
      }
      vi.setSystemTime(Date.now() + 61_000);
    }
    expect(count(state, "automation_event_deliveries")).toBeGreaterThan(100);
    const sweep = state.host.harness.runService("automation-sweep");
    await vi.waitFor(() =>
      expect(count(state, "automation_event_deliveries")).toBeLessThanOrEqual(
        103,
      ),
    );
    sweep.controller.abort();
    await sweep.done;

    const fourth = await send("match", "m4");
    expect(await fourth.json()).toMatchObject({
      outcomes: [{ automationId: automation.id, outcome: "rate_limited" }],
    });
    const replay = await send("match", "m1");
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
  });

  it("keeps dedupe ids for seven days and then lets them go", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
    const state = await boot();
    const { hook, secret } = await createHook(state.host, { source: "github" });
    await createEventAutomation(state.host, {
      hookId: hook.id,
      trigger: { events: ["never"] },
    });
    const body = JSON.stringify({ zen: "x" });
    const deliver = () =>
      post(
        state,
        hook.id,
        githubRequest({ secret, body, event: "issues", delivery: "gh-old" }),
      );
    expect((await deliver()).status).toBe(202);

    vi.setSystemTime(Date.now() + 6 * DAY_MS);
    const sweep = state.host.harness.runService("automation-sweep");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await (await deliver()).json()).toEqual({
      ok: true,
      duplicate: true,
    });

    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    sweep.controller.abort();
    await sweep.done;
    expect((await deliver()).status).toBe(202);
  }, 30_000);
});

describe("generic HMAC covers the delivery id and the event", () => {
  it("refuses a signed body with another delivery id or event", async () => {
    const state = await boot();
    const { hook, secret } = await createHook(state.host);
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
      trigger: { events: ["deploy.finished"] },
    });
    const body = JSON.stringify({ a: 1 });
    const ok = await post(
      state,
      hook.id,
      signed({ secret, body, delivery: "orig-1", event: "deploy.finished" }),
    );
    expect(ok.status).toBe(202);
    await waitForSpawns(state, 1);
    const forgedDelivery = await post(
      state,
      hook.id,
      signed({
        secret,
        body,
        delivery: "forged-2",
        signDelivery: "orig-1",
        event: "deploy.finished",
      }),
    );
    expect(forgedDelivery.status).toBe(401);
    const forgedEvent = await post(
      state,
      hook.id,
      signed({
        secret,
        body,
        delivery: "orig-3",
        event: "release.published",
        signEvent: "deploy.finished",
        signDelivery: "orig-3",
      }),
    );
    expect(forgedEvent.status).toBe(401);
    const addedDelivery = await post(
      state,
      hook.id,
      signed({
        secret,
        body,
        delivery: "added-4",
        signDelivery: "",
        event: "deploy.finished",
      }),
    );
    expect(addedDelivery.status).toBe(401);
    expect((await listEvents(state.host, automation.id)).length).toBe(1);
  });

  it("accepts a signature over the canonical string and nothing else in the adapter", () => {
    const secret = "s3cret";
    const body = Buffer.from('{"a":1}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = (text: string) =>
      createHmac("sha256", secret).update(text).digest("hex");
    const verify = (delivery: string, event: string, signature: string) =>
      webhookAdapter.verify({
        headers: new Headers({
          "x-bb-timestamp": timestamp,
          "x-bb-signature": `v1=${signature}`,
          "x-bb-delivery": delivery,
          "x-bb-event": event,
        }),
        rawBody: body,
        secret,
        verification: "hmac",
        nowMs: Date.now(),
      });
    const good = sign(signedString(timestamp, "d", "e.f", body.toString()));
    expect(verify("d", "e.f", good).ok).toBe(true);
    expect(verify("d2", "e.f", good).ok).toBe(false);
    expect(verify("d", "e.g", good).ok).toBe(false);
    expect(verify("d", "e.f", sign(`${timestamp}.${body.toString()}`)).ok).toBe(
      false,
    );
  });
});

describe("samples are never presented as verified", () => {
  it("labels a sample prompt verified=none and refuses a send from an automation thread", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host);
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
    });
    const preview = (await state.host.harness.callRpc("automations_hook_test", {
      projectId: PROJECT_ID,
      hookId: hook.id,
      payload: { a: 1 },
    })) as { promptPreviews: Array<{ prompt: string }> };
    expect(preview.promptPreviews[0]?.prompt).toContain("verified=none");
    expect(preview.promptPreviews[0]?.prompt).not.toContain("hmac-sha256");

    const db = state.host.bb.storage.database();
    db.prepare(
      "INSERT INTO automation_runs (id, automation_id, run_mode, thread_id, status, trigger, scheduled_for, started_at) VALUES ('arun_x', ?, 'agent', 'thr_running', 'running', 'event', 1, 1)",
    ).run(automation.id);
    await expect(
      state.host.harness.callRpc("automations_hook_test", {
        projectId: PROJECT_ID,
        hookId: hook.id,
        payload: { a: 1 },
        dryRun: false,
        callerThreadId: "thr_running",
      }),
    ).rejects.toThrow(/cannot create automations/u);
    db.prepare("DELETE FROM automation_runs").run();

    const sent = (await state.host.harness.callRpc("automations_hook_test", {
      projectId: PROJECT_ID,
      hookId: hook.id,
      payload: { a: 1 },
      dryRun: false,
    })) as { deliveryId: string };
    await waitForSpawns(state, 1);
    expect(String(state.spawned[0]?.prompt)).toContain("verified=none");
    expect(String(state.spawned[0]?.prompt)).not.toContain("hmac-sha256");
    expect(sent.deliveryId).toMatch(/^evd_/u);
  });

  it("refuses to send a sample to a full-access automation", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host);
    await createEventAutomation(state.host, {
      hookId: hook.id,
      permissionMode: "full",
      trigger: { acknowledgeUntrustedInput: true },
    });
    await expect(
      state.host.harness.callRpc("automations_hook_test", {
        projectId: PROJECT_ID,
        hookId: hook.id,
        payload: {},
        dryRun: false,
      }),
    ).rejects.toThrow(/full access/u);
  });

  it("passes the thread id from the CLI so a thread cannot send a sample", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host);
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
    });
    state.host.bb.storage
      .database()
      .prepare(
        "INSERT INTO automation_runs (id, automation_id, run_mode, thread_id, status, trigger, scheduled_for, started_at) VALUES ('arun_y', ?, 'agent', 'thr_running', 'running', 'event', 1, 1)",
      )
      .run(automation.id);
    const result = await state.host.harness.runCli(
      ["hook", "test", hook.id, "--project", PROJECT_ID, "--send"],
      { threadId: "thr_running" } as never,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot create automations");
  });
});

describe("target threads", () => {
  it("keeps the run open until the queued event message's own turn ends", async () => {
    const state = await boot();
    state.queue.sendDelivery = "queued";
    const { hook, secret } = await createHook(state.host);
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
      targetThreadId: "thr_target",
    });
    await post(state, hook.id, signed({ secret, body: "{}", delivery: "t1" }));
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    await post(state, hook.id, signed({ secret, body: "{}", delivery: "t2" }));

    await settle(state.host, "thr_target");
    expect((await listRuns(state.host, automation.id))[0]?.status).toBe(
      "running",
    );
    expect(state.sent).toHaveLength(1);

    state.queue.entries = [];
    await state.host.harness.emitThreadEvent("message.dispatched", {
      entry: {
        id: "qm_1",
        originPluginId: "automations",
        threadId: "thr_target",
      },
    } as never);
    await settle(state.host, "thr_target");
    await vi.waitFor(async () =>
      expect(
        (await listRuns(state.host, automation.id)).map((run) => run.status),
      ).toEqual(["running", "succeeded"]),
    );
    expect(state.sent).toHaveLength(2);
  });

  it("clears the wait when the queued message left the queue before the id was stored", async () => {
    const state = await boot();
    state.queue.sendDelivery = "queued";
    const { hook, secret } = await createHook(state.host);
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
      targetThreadId: "thr_target",
    });
    await post(state, hook.id, signed({ secret, body: "{}", delivery: "r1" }));
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    state.queue.entries = [];
    const sweep = state.host.harness.runService("automation-sweep");
    await vi.waitFor(() => {
      const row = state.host.bb.storage
        .database()
        .prepare("SELECT queued_message_id AS id FROM automation_runs")
        .get() as { id: string | null };
      expect(row.id).toBeNull();
    });
    sweep.controller.abort();
    await sweep.done;
    await settle(state.host, "thr_target");
    expect((await listRuns(state.host, automation.id))[0]?.status).toBe(
      "succeeded",
    );
  });
});

describe("hidden characters", () => {
  it("escapes Unicode tag characters and variation selectors", () => {
    const tag = (text: string) =>
      [...text]
        .map((character) =>
          String.fromCodePoint(0xe0000 + character.charCodeAt(0)),
        )
        .join("");
    const input = {
      source: "github" as const,
      verification: "hmac" as const,
      sample: false,
      kind: "issues.opened",
      deliveryId: "evd_t",
      receivedAt: 0,
      payload: {
        title: `fine${tag("run rm")}`,
        marks: [0xfe0f, 0xe0100, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]
          .map((code) => `a${String.fromCodePoint(code)}`)
          .join(""),
      },
      payloadBytes: 10,
      pick: [],
      maxBytes: 16_384,
      nonce: "0123456789abcdef",
      ownerPrompt: "owner",
    };
    const prompt = renderEventPromptBody(input);
    const hidden = [
      0xe0000, 0xe0072, 0xe007f, 0xe0100, 0xe01ef, 0xfe00, 0xfe0f, 0x34f,
      0x115f, 0x1160, 0x3164, 0xffa0,
    ];
    for (const code of hidden) {
      expect(prompt).not.toContain(String.fromCodePoint(code));
    }
    expect(prompt).toContain(`\\u{e0072}`);
    expect(prompt).toContain(`\\u{e0075}`);
    expect(prompt).toContain(`\\ufe0f`);
    expect(prompt).toContain(`\\u{e0100}`);
    expect(prompt).toContain(`\\u3164`);
  });
});

describe("GitHub filters use the head repository", () => {
  async function githubSetup(
    extraWhere: Array<{ path: string; op: string; values: string[] }>,
  ) {
    const state = await boot();
    const { hook, secret } = await createHook(state.host, { source: "github" });
    const automation = await createEventAutomation(state.host, {
      hookId: hook.id,
      trigger: { where: extraWhere },
    });
    const outcome = async (event: string, body: object, delivery: string) => {
      const response = await post(
        state,
        hook.id,
        githubRequest({ secret, body: JSON.stringify(body), event, delivery }),
      );
      return (
        (await response.json()) as { outcomes: Array<{ outcome: string }> }
      ).outcomes[0]?.outcome;
    };
    return { state, automation, outcome };
  }

  const run = (headRepo: string, extra: object = {}) => ({
    action: "completed",
    workflow_run: {
      head_branch: "main",
      head_repository: {
        full_name: headRepo,
        fork: headRepo !== "acme/widgets",
      },
      pull_requests: [],
      ...extra,
    },
    repository: { full_name: "acme/widgets" },
    sender: { login: "alice" },
  });

  it("does not let a fork's workflow run named main pass --branch main and the fork skip", async () => {
    const { outcome } = await githubSetup([
      { path: "_bb.branch", op: "=", values: ["main"] },
      { path: "_bb.fork", op: "!=", values: ["true"] },
    ]);
    expect(await outcome("workflow_run", run("mallory/widgets"), "w1")).toBe(
      "filtered",
    );
    expect(await outcome("workflow_run", run("acme/widgets"), "w2")).toBe(
      "queued",
    );
  });

  it("treats check suites, check runs and pull requests from another repository as forks", async () => {
    const { outcome } = await githubSetup([
      { path: "_bb.fork", op: "!=", values: ["true"] },
    ]);
    const suite = (headRepo: string) => ({
      action: "completed",
      check_suite: {
        head_branch: "main",
        head_repository: { full_name: headRepo },
      },
      repository: { full_name: "acme/widgets" },
      sender: { login: "alice" },
    });
    const checkRun = (headId: number) => ({
      action: "completed",
      check_run: {
        check_suite: { head_branch: "main" },
        pull_requests: [
          { head: { repo: { id: headId } }, base: { repo: { id: 1 } } },
        ],
      },
      repository: { full_name: "acme/widgets" },
      sender: { login: "alice" },
    });
    expect(await outcome("check_suite", suite("mallory/widgets"), "c1")).toBe(
      "filtered",
    );
    expect(await outcome("check_run", checkRun(99), "c2")).toBe("filtered");
    expect(await outcome("check_run", checkRun(1), "c3")).toBe("queued");
  });
});

describe("the actor allow-list covers who wrote the text", () => {
  it("requires an author allow-list clause for full access on GitHub", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host, { source: "github" });
    await expect(
      createEventAutomation(state.host, {
        hookId: hook.id,
        permissionMode: "full",
        trigger: {
          acknowledgeUntrustedInput: true,
          where: [{ path: "_bb.actor", op: "in", values: ["owner"] }],
        },
      }),
    ).rejects.toThrow(/author/u);
    await expect(
      createEventAutomation(state.host, {
        hookId: hook.id,
        permissionMode: "full",
        trigger: {
          acknowledgeUntrustedInput: true,
          where: [
            { path: "_bb.actor", op: "in", values: ["owner"] },
            { path: "_bb.authors", op: "within", values: ["owner"] },
          ],
        },
      }),
    ).resolves.toBeDefined();
  });

  it("filters an event the owner caused on text a stranger wrote", async () => {
    const state = await boot();
    const { hook, secret } = await createHook(state.host, { source: "github" });
    await createEventAutomation(state.host, {
      hookId: hook.id,
      trigger: {
        where: [
          { path: "_bb.actor", op: "in", values: ["owner"] },
          { path: "_bb.authors", op: "within", values: ["owner"] },
        ],
      },
    });
    const outcome = async (
      body: object,
      delivery: string,
      event = "issues",
    ) => {
      const response = await post(
        state,
        hook.id,
        githubRequest({ secret, body: JSON.stringify(body), event, delivery }),
      );
      return (
        (await response.json()) as { outcomes: Array<{ outcome: string }> }
      ).outcomes[0]?.outcome;
    };
    const labeled = (issueAuthor: string) => ({
      action: "labeled",
      issue: { number: 1, body: "text", user: { login: issueAuthor } },
      label: { name: "bug" },
      repository: { full_name: "acme/widgets" },
      sender: { login: "owner" },
    });
    expect(await outcome(labeled("stranger"), "a1")).toBe("filtered");
    expect(await outcome(labeled("owner"), "a2")).toBe("queued");
    const comment = {
      action: "created",
      issue: { number: 1, user: { login: "owner" } },
      comment: { body: "hi", user: { login: "stranger" } },
      repository: { full_name: "acme/widgets" },
      sender: { login: "owner" },
    };
    expect(await outcome(comment, "a3", "issue_comment")).toBe("filtered");
    const push = {
      ref: "refs/heads/main",
      commits: [
        { author: { name: "x", email: "x@example.com" }, message: "hi" },
      ],
      repository: { full_name: "acme/widgets" },
      sender: { login: "owner" },
    };
    expect(await outcome(push, "a4", "push")).toBe("filtered");
  });
});

describe("secrets are never printed inside a thread", () => {
  const AGENT = ["--prompt", "p", "--provider", "codex", "--model", "gpt-5"];

  it("withholds the secret from create in a thread and says how to reveal it", async () => {
    const state = await boot();
    const result = await state.host.harness.runCli(
      [
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        "T",
        "--on",
        "webhook",
        ...AGENT,
        "--json",
      ],
      { threadId: "thr_chat" } as never,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const created = JSON.parse(result.stdout) as {
      secret?: string;
      secretWithheld?: string;
      hook: { id: string };
    };
    const stored = await readSecretMode(state.host, created.hook.id);
    expect(created.secret).toBeUndefined();
    expect(result.stdout).not.toContain(stored.content);
    expect(created.secretWithheld).toContain("bb automation hook rotate");
    expect(created.secretWithheld).toContain("Rotate secret");

    const human = await state.host.harness.runCli(
      [
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        "T2",
        "--on",
        "webhook",
        ...AGENT,
      ],
      { threadId: "thr_chat" } as never,
    );
    expect(human.stdout).toContain("Secret withheld");
    expect(human.stdout).not.toContain("Secret (shown once");
  });

  it("refuses rotate and hook create reveals in a thread", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host);
    const rotate = await state.host.harness.runCli(
      ["hook", "rotate", hook.id, "--project", PROJECT_ID, "--yes"],
      { threadId: "thr_chat" } as never,
    );
    expect(rotate.exitCode).toBe(1);
    expect(rotate.stderr).toContain("outside a thread");
    const create = await state.host.harness.runCli(
      [
        "hook",
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        "H",
        "--source",
        "webhook",
        "--json",
      ],
      { threadId: "thr_chat" } as never,
    );
    const body = JSON.parse(create.stdout) as {
      secret?: string;
      hook: { id: string };
    };
    expect(body.secret).toBeUndefined();
    const stored = await readSecretMode(state.host, body.hook.id);
    expect(create.stdout).not.toContain(stored.content);
  });

  it("still prints the secret once outside a thread", async () => {
    const state = await boot();
    const result = await state.host.harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "T3",
      "--on",
      "webhook",
      ...AGENT,
      "--json",
    ]);
    const created = JSON.parse(result.stdout) as {
      secret: string;
      hook: { id: string };
    };
    expect((await readSecretMode(state.host, created.hook.id)).content).toBe(
      created.secret,
    );
  });
});

describe("unverified requests", () => {
  it("batches rejection writes and still reports every rejection", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host);
    await createEventAutomation(state.host, { hookId: hook.id });
    const db = state.host.bb.storage.database();
    const writes: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("rejected_count = rejected_count + 1")) writes.push(sql);
      return prepare(sql);
    });
    for (let index = 0; index < 200; index += 1) {
      await post(
        state,
        hook.id,
        signed({ secret: "wrong", body: "{}", delivery: `x-${index}` }),
      );
    }
    const statementRuns = writes.length;
    const fetched = (await state.host.harness.callRpc("automations_hook_get", {
      projectId: PROJECT_ID,
      hookId: hook.id,
    })) as { rejectedCount: number };
    expect(fetched.rejectedCount).toBe(200);
    const stored = db
      .prepare("SELECT rejected_count AS n FROM automation_hooks WHERE id = ?")
      .get(hook.id) as { n: number };
    expect(stored.n).toBeLessThan(200);
    expect(statementRuns).toBeLessThanOrEqual(1);
  });

  it("stops reading a body that never ends", async () => {
    const state = await boot();
    const { hook } = await createHook(state.host);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const started = Date.now();
    const response = await state.host.harness.fetchHttp(
      "POST",
      `${WEBHOOK_PATH}?hook=${hook.id}`,
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
    );
    expect(response.status).toBe(408);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe("full-access acknowledgement and filters", () => {
  const AGENT = ["--prompt", "p", "--provider", "codex", "--model", "gpt-5"];

  it("can be withdrawn with --revoke-full-access-for-events, and drops when the mode drops", async () => {
    const state = await boot();
    const created = JSON.parse(
      (
        await state.host.harness.runCli([
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Ack",
          "--on",
          "webhook",
          "--permission-mode",
          "full",
          "--allow-full-access-for-events",
          ...AGENT,
          "--json",
        ])
      ).stdout,
    ) as { id: string; trigger: { acknowledgeUntrustedInput: boolean } };
    expect(created.trigger.acknowledgeUntrustedInput).toBe(true);
    const lowered = JSON.parse(
      (
        await state.host.harness.runCli([
          "update",
          created.id,
          "--project",
          PROJECT_ID,
          "--permission-mode",
          "auto",
          "--json",
        ])
      ).stdout,
    ) as { trigger: { acknowledgeUntrustedInput: boolean } };
    expect(lowered.trigger.acknowledgeUntrustedInput).toBe(false);

    const again = await state.host.harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "full",
    ]);
    expect(again.exitCode).toBe(1);
    const reack = await state.host.harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--allow-full-access-for-events",
      "--permission-mode",
      "full",
    ]);
    expect(reack.exitCode, reack.stderr).toBe(0);
    const refused = await state.host.harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--revoke-full-access-for-events",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("allow-full-access-for-events");
    const revoked = JSON.parse(
      (
        await state.host.harness.runCli([
          "update",
          created.id,
          "--project",
          PROJECT_ID,
          "--revoke-full-access-for-events",
          "--permission-mode",
          "accept-edits",
          "--json",
        ])
      ).stdout,
    ) as {
      trigger: { acknowledgeUntrustedInput: boolean };
      execution: { permissionMode: string };
    };
    expect(revoked.trigger.acknowledgeUntrustedInput).toBe(false);
    expect(revoked.execution.permissionMode).toBe("accept-edits");
  });

  it("supports a negated contains filter, and compiles --actor to the sender and the authors", async () => {
    const state = await boot();
    const result = JSON.parse(
      (
        await state.host.harness.runCli([
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Loop",
          "--on",
          "github",
          "--actor",
          "owner",
          "--where",
          "comment.body !contains bb-agent-marker",
          ...AGENT,
          "--json",
        ])
      ).stdout,
    ) as {
      trigger: { where: Array<{ path: string; op: string; values: string[] }> };
    };
    expect(result.trigger.where).toEqual(
      expect.arrayContaining([
        { path: "comment.body", op: "!contains", values: ["bb-agent-marker"] },
        { path: "_bb.actor", op: "in", values: ["owner"] },
        { path: "_bb.authors", op: "within", values: ["owner"] },
      ]),
    );
    const { hook, secret } = await createHook(state.host, { source: "github" });
    await createEventAutomation(state.host, {
      hookId: hook.id,
      trigger: {
        where: [
          {
            path: "comment.body",
            op: "!contains",
            values: ["bb-agent-marker"],
          },
        ],
      },
    });
    const outcome = async (text: string, delivery: string) => {
      const response = await post(
        state,
        hook.id,
        githubRequest({
          secret,
          body: JSON.stringify({ action: "created", comment: { body: text } }),
          event: "issue_comment",
          delivery,
        }),
      );
      return (
        (await response.json()) as { outcomes: Array<{ outcome: string }> }
      ).outcomes[0]?.outcome;
    };
    expect(await outcome("hello", "n1")).toBe("queued");
    expect(await outcome("done <!-- bb-agent-marker -->", "n2")).toBe(
      "filtered",
    );
  });
});

describe("unverified requests are limited per sender", () => {
  it("blocks a forwarded sender after 300 failures a minute and leaves others alone", async () => {
    const state = await boot();
    const { hook, secret } = await createHook(state.host);
    await createEventAutomation(state.host, { hookId: hook.id });
    const bad = (forwardedFor: string, delivery: string) => {
      const init = signed({ secret: "wrong", body: "{}", delivery });
      return post(state, hook.id, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          "x-forwarded-for": forwardedFor,
        },
      });
    };
    let blocked = 0;
    for (let index = 0; index < 320; index += 1) {
      const response = await bad("203.0.113.9", `f-${index}`);
      if (response.status === 429) blocked += 1;
    }
    expect(blocked).toBe(20);
    expect((await bad("198.51.100.4", "other")).status).toBe(401);
    const init = signed({ secret, body: "{}", delivery: "real" });
    const real = await post(state, hook.id, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        "x-forwarded-for": "198.51.100.4",
      },
    });
    expect(real.status).toBe(202);
  });
});
