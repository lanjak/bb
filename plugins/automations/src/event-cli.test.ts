import { afterEach, describe, expect, it } from "vitest";
import {
  bootEventHost,
  genericRequest,
  PROJECT_ID,
  waitForSpawns,
  type EventTestHost,
} from "./event-test-host.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(
  options: Parameters<typeof bootEventHost>[0] = {},
): Promise<EventTestHost> {
  const state = await bootEventHost(options);
  cleanups.push(() => state.host.harness.dispose());
  return state;
}

const AGENT_FLAGS = [
  "--prompt",
  "Triage it.",
  "--provider",
  "codex",
  "--model",
  "gpt-5",
];

async function run(state: EventTestHost, argv: string[], threadId?: string) {
  return state.host.harness.runCli(argv, {
    ...(threadId === undefined ? {} : { threadId }),
  } as never);
}

function jsonOf<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

describe("bb automation create --on", () => {
  it("creates a hook, defaults to accept-edits, and prints the secret once", async () => {
    const state = await boot();
    const result = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "CI watcher",
      "--on",
      "webhook",
      "--event",
      "ci.failed",
      "--where",
      "branch = main",
      "--pick",
      "branch",
      "--pick",
      "job.name",
      "--max-runs-per-hour",
      "5",
      ...AGENT_FLAGS,
      "--json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const created = jsonOf<{
      id: string;
      secret: string;
      hook: { id: string; url: string; source: string };
      trigger: Record<string, unknown>;
      execution: { permissionMode: string };
    }>(result.stdout);
    expect(created.execution.permissionMode).toBe("accept-edits");
    expect(created.trigger).toMatchObject({
      triggerType: "event",
      hookId: created.hook.id,
      events: ["ci.failed"],
      where: [{ path: "branch", op: "=", values: ["main"] }],
      pick: ["branch", "job.name"],
      maxRunsPerHour: 5,
      acknowledgeUntrustedInput: false,
    });
    expect(created.secret.length).toBeGreaterThan(30);
    expect(created.hook.url).toContain(`/webhook?hook=${created.hook.id}`);

    const shown = await run(state, [
      "hook",
      "show",
      created.hook.id,
      "--project",
      PROJECT_ID,
    ]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).not.toContain(created.secret);
    expect(shown.stdout).toContain("openssl dgst -sha256 -hmac");
    expect(shown.stdout).toContain("Only this machine can reach this address");
    expect(shown.stdout).toContain(
      "Forward only /api/v1/plugins/automations/http/webhook to this server and answer 404 for every other path",
    );
    expect(shown.stdout).toContain("upstream Host header");
    expect(shown.stdout).toContain('DELIVERY="deploy-$TS"');

    const response = await state.host.harness.fetchHttp(
      "POST",
      `/webhook?hook=${created.hook.id}`,
      genericRequest({
        secret: created.secret,
        body: JSON.stringify({ branch: "main", job: { name: "unit" } }),
        event: "ci.failed",
      }),
    );
    expect(response.status).toBe(202);
    await waitForSpawns(state, 1);
  });

  it("prints the new secret and the loopback warning in the human output", async () => {
    const state = await boot();
    const result = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Plain",
      "--on",
      "webhook",
      ...AGENT_FLAGS,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Secret (shown once");
    expect(result.stdout).toContain(
      "Warning: Only this machine can reach this address",
    );
    expect(result.stdout).toContain("Cap:       20 runs per hour");
    expect(result.stdout).not.toMatch(/bb connect/iu);
  });

  it("compiles the GitHub flags to filters and skips forks by default", async () => {
    const state = await boot();
    const result = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Labels",
      "--on",
      "github",
      "--event",
      "issues.labeled",
      "--repo",
      "acme/widgets",
      "--label",
      "bug",
      "--branch",
      "main",
      "--ignore-actor",
      "bot-me",
      ...AGENT_FLAGS,
      "--json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const created = jsonOf<{ trigger: { where: unknown[] } }>(result.stdout);
    expect(created.trigger.where).toEqual([
      { path: "_bb.repo", op: "=", values: ["acme/widgets"] },
      { path: "_bb.branch", op: "=", values: ["main"] },
      { path: "_bb.label", op: "=", values: ["bug"] },
      { path: "_bb.actor", op: "!=", values: ["bot-me"] },
      { path: "_bb.fork", op: "!=", values: ["true"] },
    ]);
    const withForks = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Forks",
      "--on",
      "github",
      "--include-forks",
      ...AGENT_FLAGS,
      "--json",
    ]);
    expect(
      jsonOf<{ trigger: { where: unknown[] } }>(withForks.stdout).trigger.where,
    ).toEqual([]);
  });

  it("refuses full access without the flag, and github full access without an actor", async () => {
    const state = await boot();
    const base = [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Full",
      "--on",
      "github",
      ...AGENT_FLAGS,
      "--permission-mode",
      "full",
    ];
    const bare = await run(state, base);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("--allow-full-access-for-events");
    const noActor = await run(state, [
      ...base,
      "--allow-full-access-for-events",
    ]);
    expect(noActor.exitCode).toBe(1);
    expect(noActor.stderr).toContain("allow-list of actors");
    const ok = await run(state, [
      ...base,
      "--allow-full-access-for-events",
      "--actor",
      "alice",
    ]);
    expect(ok.exitCode, ok.stderr).toBe(0);
    const hooks = await run(state, [
      "hook",
      "list",
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(jsonOf<unknown[]>(hooks.stdout)).toHaveLength(1);
  });

  it("removes the hook it created when the automation is refused", async () => {
    const state = await boot();
    const result = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Refused",
      "--on",
      "webhook",
      ...AGENT_FLAGS,
      "--permission-mode",
      "full",
    ]);
    expect(result.exitCode).toBe(1);
    const hooks = await run(state, [
      "hook",
      "list",
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(jsonOf<unknown[]>(hooks.stdout)).toEqual([]);
  });

  it("rejects flags that do not fit", async () => {
    const state = await boot();
    const noOn = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "x",
      "--in",
      "5m",
      "--event",
      "a",
      ...AGENT_FLAGS,
    ]);
    expect(noOn.exitCode).toBe(1);
    const githubFlagOnWebhook = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "x",
      "--on",
      "webhook",
      "--repo",
      "a/b",
      ...AGENT_FLAGS,
    ]);
    expect(githubFlagOnWebhook.stderr).toContain("apply to GitHub hooks");
    const both = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "x",
      "--on",
      "webhook",
      "--in",
      "5m",
      ...AGENT_FLAGS,
    ]);
    expect(both.exitCode).toBe(1);
    const badWhere = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "x",
      "--on",
      "webhook",
      "--where",
      "nonsense",
      ...AGENT_FLAGS,
    ]);
    expect(badWhere.stderr).toContain("Invalid --where");
  });
});

describe("hook commands", () => {
  it("creates, tests, rotates and deletes hooks", async () => {
    const state = await boot({
      settings: { webhookBaseUrl: "https://bb.example.com" },
    });
    const created = jsonOf<{
      hook: { id: string; url: string };
      secret: string;
    }>(
      (
        await run(state, [
          "hook",
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Deploys",
          "--source",
          "webhook",
          "--json",
        ])
      ).stdout,
    );
    expect(
      created.hook.url.startsWith(
        "https://bb.example.com/api/v1/plugins/automations/http/webhook?hook=hk_",
      ),
    ).toBe(true);
    await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Uses hook",
      "--on",
      "webhook",
      "--hook",
      created.hook.id,
      ...AGENT_FLAGS,
    ]);
    const dry = await run(state, [
      "hook",
      "test",
      created.hook.id,
      "--project",
      PROJECT_ID,
      "--payload-json",
      '{"a":1}',
      "--kind",
      "deploy.done",
    ]);
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Dry run of deploy.done: nothing was stored");
    expect(dry.stdout).toContain('"a": 1');
    expect(state.spawned).toHaveLength(0);

    const needsYes = await run(state, [
      "hook",
      "rotate",
      created.hook.id,
      "--project",
      PROJECT_ID,
    ]);
    expect(needsYes.exitCode).toBe(1);
    const rotated = jsonOf<{ secret: string }>(
      (
        await run(state, [
          "hook",
          "rotate",
          created.hook.id,
          "--project",
          PROJECT_ID,
          "--yes",
          "--json",
        ])
      ).stdout,
    );
    expect(rotated.secret).not.toBe(created.secret);

    const inUse = await run(state, [
      "hook",
      "delete",
      created.hook.id,
      "--project",
      PROJECT_ID,
      "--yes",
    ]);
    expect(inUse.exitCode).toBe(1);
    expect(inUse.stderr).toContain("is used by");

    const sent = await run(state, [
      "hook",
      "test",
      created.hook.id,
      "--project",
      PROJECT_ID,
      "--payload-json",
      '{"a":2}',
      "--send",
      "--json",
    ]);
    const sample = jsonOf<{ deliveryId: string }>(sent.stdout);
    await waitForSpawns(state, 1);
    const shown = await run(state, [
      "event",
      "show",
      sample.deliveryId,
      "--project",
      PROJECT_ID,
    ]);
    expect(shown.stdout).toContain("[sample]");
    expect(shown.stdout).toContain('"a": 2');
  });

  it("lists deliveries for an automation", async () => {
    const state = await boot();
    const created = jsonOf<{
      id: string;
      hook: { id: string };
      secret: string;
    }>(
      (
        await run(state, [
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Log",
          "--on",
          "webhook",
          ...AGENT_FLAGS,
          "--json",
        ])
      ).stdout,
    );
    await state.host.harness.fetchHttp(
      "POST",
      `/webhook?hook=${created.hook.id}`,
      genericRequest({
        secret: created.secret,
        body: "{}",
        event: "x.y",
        delivery: "log-1",
      }),
    );
    await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Other",
      "--on",
      "webhook",
      "--hook",
      created.hook.id,
      "--where",
      "never = true",
      ...AGENT_FLAGS,
    ]);
    await state.host.harness.fetchHttp(
      "POST",
      `/webhook?hook=${created.hook.id}`,
      genericRequest({
        secret: created.secret,
        body: "{}",
        event: "x.z",
        delivery: "log-2",
      }),
    );
    const listed = await run(state, [
      "events",
      created.id,
      "--project",
      PROJECT_ID,
    ]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("x.y");
    expect(listed.stdout).toContain("x.z");
    expect(listed.stdout).not.toContain("filtered");
    const byHook = await run(state, [
      "events",
      created.hook.id,
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(jsonOf<{ events: unknown[] }>(byHook.stdout).events).toHaveLength(2);
  });

  it("updates event filters in place and keeps the rest", async () => {
    const state = await boot();
    const created = jsonOf<{ id: string; hook: { id: string } }>(
      (
        await run(state, [
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Upd",
          "--on",
          "webhook",
          "--event",
          "a.b",
          "--max-runs-per-hour",
          "7",
          ...AGENT_FLAGS,
          "--json",
        ])
      ).stdout,
    );
    const updated = jsonOf<{ trigger: Record<string, unknown> }>(
      (
        await run(state, [
          "update",
          created.id,
          "--project",
          PROJECT_ID,
          "--where",
          "x = 1",
          "--json",
        ])
      ).stdout,
    );
    expect(updated.trigger).toMatchObject({
      hookId: created.hook.id,
      events: ["a.b"],
      maxRunsPerHour: 7,
      where: [{ path: "x", op: "=", values: ["1"] }],
    });
    const notEvent = await run(state, [
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Sched",
      "--in",
      "1h",
      ...AGENT_FLAGS,
      "--json",
    ]);
    const scheduled = jsonOf<{ id: string }>(notEvent.stdout);
    const bad = await run(state, [
      "update",
      scheduled.id,
      "--project",
      PROJECT_ID,
      "--event",
      "a",
    ]);
    expect(bad.exitCode).toBe(1);
  });
});
