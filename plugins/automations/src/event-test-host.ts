import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import {
  automationHookSecretResponseSchema,
  automationRunListResponseSchema,
  automationDetailResponseSchema,
  automationEventListResponseSchema,
  type AutomationRunResponse,
} from "./rpc-types.js";

export const PROJECT_ID = "proj_test";

export type ThreadStatus =
  | "pending"
  | "idle"
  | "active"
  | "starting"
  | "stopping"
  | "error";

export interface EventTestHost {
  host: FakePluginHost;
  spawned: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  statuses: Map<string, ThreadStatus>;
  retryDecision: { value: "absent" | "queued" };
  queue: {
    entries: Array<{ id: string; threadId: string }>;
    sendDelivery: "sent" | "queued";
    nextQueuedId: number;
  };
}

function project() {
  return {
    id: PROJECT_ID,
    kind: "standard" as const,
    name: "Test Project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    sources: [],
  };
}

export async function bootEventHost(
  options: {
    appUrl?: string | null;
    settings?: Record<string, string>;
    hostsConnected?: boolean;
  } = {},
): Promise<EventTestHost> {
  const spawned: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const statuses = new Map<string, ThreadStatus>();
  const retryDecision: EventTestHost["retryDecision"] = { value: "absent" };
  const queue: EventTestHost["queue"] = {
    entries: [],
    sendDelivery: "sent",
    nextQueuedId: 1,
  };
  const host = createFakePluginHost({
    pluginId: "automations",
    appUrl: options.appUrl ?? null,
    loopbackBaseUrl: "http://127.0.0.1:38886",
    settings: options.settings ?? {},
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_fake" }) },
      projects: {
        async get({ projectId }) {
          if (projectId === PROJECT_ID) return project();
          throw new Error("Project not found");
        },
        async list() {
          return [project()];
        },
      },
      hosts: {
        async list() {
          return [
            {
              id: "host_test",
              status:
                options.hostsConnected === false ? "disconnected" : "connected",
            },
          ];
        },
      },
      providers: {
        async list() {
          return [
            {
              id: "codex",
              capabilities: {
                permissionModes: ["accept-edits", "auto", "full"],
              },
            },
          ];
        },
      },
      threads: {
        async get({ threadId }) {
          return {
            ...makeThreadResponse({ id: threadId }),
            id: threadId,
            archivedAt: null,
            deletedAt: null,
            originPluginId: null,
            status: statuses.get(threadId) ?? "idle",
          };
        },
        async send(args) {
          sent.push(args as unknown as Record<string, unknown>);
          if (queue.sendDelivery === "queued") {
            const id = `qm_${queue.nextQueuedId++}`;
            queue.entries.push({
              id,
              threadId: (args as unknown as { threadId: string }).threadId,
            });
            return {
              ok: true,
              delivery: "queued",
              queuedMessage: { id, originPluginId: "automations" },
            };
          }
          return { ok: true, delivery: "sent" };
        },
        async spawn(args) {
          spawned.push(args as unknown as Record<string, unknown>);
          const id = `thr_event_${spawned.length}`;
          statuses.set(id, "active");
          return { id, archivedAt: null, deletedAt: null, status: "active" };
        },
        events: {
          async list() {
            return [
              {
                type: "client/turn/requested",
                data: {
                  requestId: "creq_failed",
                  target: { kind: "new-turn" },
                },
              },
            ] as never;
          },
        },
        queue: {
          async list(args) {
            const threadId = args?.threadId;
            const own = queue.entries
              .filter((entry) => entry.threadId === threadId)
              .map((entry) => ({ id: entry.id, payload: { kind: "message" } }));
            const retry =
              retryDecision.value === "queued"
                ? [
                    {
                      id: "qr",
                      payload: { kind: "retry", reason: "provider overloaded" },
                    },
                  ]
                : [];
            return [...own, ...retry] as never;
          },
        },
      },
      plugins: {
        async experimental_discoverRpc() {
          return [];
        },
      },
    },
  });
  await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
  return { host, spawned, sent, statuses, retryDecision, queue };
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function genericRequest(args: {
  secret: string;
  body: string;
  event?: string;
  delivery?: string;
  timestamp?: number;
  signature?: string;
  extraHeaders?: Record<string, string>;
}): RequestInit {
  const timestamp = String(args.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    body: args.body,
    headers: {
      "content-type": "application/json",
      "x-bb-timestamp": timestamp,
      "x-bb-signature":
        args.signature ??
        `v1=${hmacHex(args.secret, `${timestamp}\n${args.delivery ?? ""}\n${args.event ?? ""}\n${args.body}`)}`,
      ...(args.event === undefined ? {} : { "x-bb-event": args.event }),
      ...(args.delivery === undefined
        ? {}
        : { "x-bb-delivery": args.delivery }),
      ...args.extraHeaders,
    },
  };
}

export function githubRequest(args: {
  secret: string;
  body: string;
  event: string;
  delivery: string;
}): RequestInit {
  return {
    method: "POST",
    body: args.body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${hmacHex(args.secret, args.body)}`,
      "x-github-event": args.event,
      "x-github-delivery": args.delivery,
    },
  };
}

export async function createHook(
  host: FakePluginHost,
  input: {
    name?: string;
    source?: "webhook" | "github";
    verification?: "hmac" | "token";
  } = {},
) {
  return automationHookSecretResponseSchema.parse(
    await host.harness.callRpc("automations_hook_create", {
      projectId: PROJECT_ID,
      name: input.name ?? "Test hook",
      source: input.source ?? "webhook",
      ...(input.verification === undefined
        ? {}
        : { verification: input.verification }),
    }),
  );
}

export async function createEventAutomation(
  host: FakePluginHost,
  args: {
    hookId: string;
    name?: string;
    prompt?: string;
    trigger?: Record<string, unknown>;
    permissionMode?: "accept-edits" | "auto" | "full";
    targetThreadId?: string;
    enabled?: boolean;
  },
) {
  return automationDetailResponseSchema.parse(
    await host.harness.callRpc("automations_create", {
      projectId: PROJECT_ID,
      name: args.name ?? "On event",
      enabled: args.enabled ?? true,
      trigger: { triggerType: "event", hookId: args.hookId, ...args.trigger },
      execution: {
        mode: "agent",
        prompt: args.prompt ?? "Triage the event.",
        providerId: "codex",
        model: "gpt-5",
        permissionMode: args.permissionMode ?? "accept-edits",
        environment: { type: "project-default" },
        ...(args.targetThreadId === undefined
          ? {}
          : { targetThreadId: args.targetThreadId }),
      },
      origin: "human",
    }),
  );
}

export async function listRuns(
  host: FakePluginHost,
  automationId: string,
): Promise<AutomationRunResponse[]> {
  return automationRunListResponseSchema.parse(
    await host.harness.callRpc("automations_runs", {
      projectId: PROJECT_ID,
      automationId,
    }),
  ).runs;
}

export async function listEvents(host: FakePluginHost, automationId: string) {
  return automationEventListResponseSchema.parse(
    await host.harness.callRpc("automations_events", {
      projectId: PROJECT_ID,
      automationId,
    }),
  ).events;
}

export async function settle(
  host: FakePluginHost,
  threadId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  await host.harness.emitThreadEvent("experimental_thread.settled", {
    outcome,
    thread: makeThreadResponse({ id: threadId, projectId: PROJECT_ID }),
    ...(outcome === "completed"
      ? { lastAssistantText: null }
      : { error: "Turn failed" }),
  } as never);
}

export async function waitForSpawns(
  state: EventTestHost,
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(state.spawned).toHaveLength(count));
}

export async function readSecretMode(
  host: FakePluginHost,
  hookId: string,
): Promise<{ content: string; mode: number }> {
  const db = host.bb.storage.database();
  const row = db
    .prepare("PRAGMA database_list")
    .all()
    .find((entry) => (entry as { name?: string }).name === "main") as {
    file: string;
  };
  const path = join(row.file, "..", "hook-secrets", hookId);
  const { stat } = await import("node:fs/promises");
  return {
    content: await readFile(path, "utf8"),
    mode: (await stat(path)).mode & 0o777,
  };
}
