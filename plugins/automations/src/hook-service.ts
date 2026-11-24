import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  parseAutomationExecution,
  parseAutomationTrigger,
  type Db,
} from "./data.js";
import {
  evaluateAutomationsForEvent,
  ingestDelivery,
  renderEventPromptForAutomation,
} from "./event-ingest.js";
import {
  bumpHookSecretVersion,
  deleteHook,
  getDelivery,
  getHook,
  getHookForProject,
  insertHook,
  listDeliveriesForAutomation,
  listDeliveriesForHook,
  listEventAutomationsForHook,
  listHooksForProject,
  listOutcomesForDelivery,
  type DeliveryRow,
  type HookRow,
  type OutcomeRow,
} from "./hooks.js";
import {
  deleteHookSecret,
  generateHookSecret,
  writeHookSecret,
} from "./hook-secrets.js";
import { createHookId } from "./ids.js";
import { resolveWebhookBase, webhookUrl } from "./hook-url.js";
import { getAutomationForProject } from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { pendingRejections } from "./rejections.js";
import { renderAutomationDueMessage } from "./run.js";
import {
  automationEventDetailSchema,
  automationEventListResponseSchema,
  automationHookListResponseSchema,
  automationHookResponseSchema,
  automationHookSecretResponseSchema,
  hookTestResponseSchema,
  type AutomationEventDetail,
  type AutomationEventListResponse,
  type AutomationEventOutcomeResponse,
  type AutomationEventSummary,
  type AutomationHookResponse,
  type AutomationHookSecretResponse,
  type HookTestResponse,
  type ResolvedCreateHookInput,
  type ResolvedListEventsInput,
  type ResolvedTestHookInput,
} from "./rpc-types.js";

type HookServiceApi = Pick<BbPluginApi, "realtime"> & {
  server: Pick<
    BbPluginApi["server"],
    "loopbackBaseUrl" | "experimental_appUrl"
  >;
};

export interface HookService {
  list(input: { projectId: string }): Promise<AutomationHookResponse[]>;
  get(input: {
    projectId: string;
    hookId: string;
  }): Promise<AutomationHookResponse>;
  create(input: ResolvedCreateHookInput): Promise<AutomationHookSecretResponse>;
  rotate(input: {
    projectId: string;
    hookId: string;
    callerThreadId?: string;
  }): Promise<AutomationHookSecretResponse>;
  delete(input: {
    projectId: string;
    hookId: string;
    callerThreadId?: string;
  }): Promise<{ ok: true }>;
  test(input: ResolvedTestHookInput): Promise<HookTestResponse>;
  events(input: ResolvedListEventsInput): AutomationEventListResponse;
  event(input: {
    projectId: string;
    deliveryId: string;
  }): AutomationEventDetail;
}

export interface HookServiceDeps {
  bb: HookServiceApi;
  db: Db;
  pluginDataDir: string;
  webhookBaseUrlSetting: () => Promise<string | undefined>;
  assertProjectAvailable: (projectId: string) => Promise<void>;
  assertNotRecursive: (callerThreadId: string | undefined) => Promise<void>;
  onQueued: () => void;
}

function outcomeResponse(row: OutcomeRow): AutomationEventOutcomeResponse {
  return {
    automationId: row.automationId,
    outcome: row.outcome,
    runId: row.runId,
    reason: row.reason,
    updatedAt: row.updatedAt,
  };
}

function encodeEventCursor(delivery: DeliveryRow): string {
  return Buffer.from(`${delivery.receivedAt}:${delivery.id}`, "utf8").toString(
    "base64url",
  );
}

function parseEventCursor(
  cursor: string | undefined,
): { receivedAt: number; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  const receivedAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator <= 0 || !Number.isFinite(receivedAt) || id === "") {
    throw new Error("Invalid events cursor");
  }
  return { receivedAt, id };
}

export function createHookService(deps: HookServiceDeps): HookService {
  const { bb, db, pluginDataDir } = deps;

  async function toResponse(row: HookRow): Promise<AutomationHookResponse> {
    const base = resolveWebhookBase({
      settingValue: await deps.webhookBaseUrlSetting(),
      appUrl: bb.server.experimental_appUrl,
      loopbackBaseUrl: bb.server.loopbackBaseUrl,
    });
    return automationHookResponseSchema.parse({
      ...row,
      rejectedCount: row.rejectedCount + pendingRejections(row.id),
      url: webhookUrl(base, row.id),
      urlSource: base.source,
      urlScope: base.scope,
      urlWarning: base.warning,
      automationIds: listEventAutomationsForHook(db, row.id).map(
        (automation) => automation.id,
      ),
    });
  }

  function requireHook(args: { projectId: string; hookId: string }): HookRow {
    const row = getHookForProject(db, args);
    if (row === null) throw new Error("Hook not found");
    return row;
  }

  function summarize(
    delivery: DeliveryRow,
    source: HookRow["source"],
  ): AutomationEventSummary {
    return {
      id: delivery.id,
      hookId: delivery.hookId,
      source,
      kind: delivery.eventKind,
      receivedAt: delivery.receivedAt,
      sample: delivery.sample,
      payloadBytes: delivery.payloadBytes,
      outcomes: listOutcomesForDelivery(db, delivery.id).map(outcomeResponse),
    };
  }

  function previewsFor(
    hook: HookRow,
    delivery: Pick<
      DeliveryRow,
      | "id"
      | "eventKind"
      | "receivedAt"
      | "payloadJson"
      | "payloadBytes"
      | "sample"
    >,
    automationIds: readonly string[],
  ): Array<{ automationId: string; prompt: string }> {
    const previews: Array<{ automationId: string; prompt: string }> = [];
    for (const automation of listEventAutomationsForHook(db, hook.id)) {
      if (!automationIds.includes(automation.id)) continue;
      const body = renderEventPromptForAutomation({
        automation,
        hook,
        delivery,
        nonce: "preview",
      });
      if (body === null) continue;
      previews.push({
        automationId: automation.id,
        prompt: renderAutomationDueMessage({
          automationId: automation.id,
          prompt: "",
          eventBody: body,
        }),
      });
    }
    return previews;
  }

  return {
    async list(input) {
      await deps.assertProjectAvailable(input.projectId);
      return automationHookListResponseSchema.parse(
        await Promise.all(
          listHooksForProject(db, input.projectId).map(toResponse),
        ),
      );
    },

    async get(input) {
      return toResponse(requireHook(input));
    },

    async create(input) {
      await deps.assertProjectAvailable(input.projectId);
      await deps.assertNotRecursive(input.callerThreadId);
      const id = createHookId();
      const secret = generateHookSecret();
      const row = insertHook(db, {
        id,
        projectId: input.projectId,
        source: input.source,
        verification: input.verification,
        name: input.name,
        now: Date.now(),
      });
      try {
        await writeHookSecret({ pluginDataDir, hookId: id, secret });
      } catch (error) {
        deleteHook(db, id);
        throw error;
      }
      return automationHookSecretResponseSchema.parse({
        hook: await toResponse(row),
        secret,
      });
    },

    async rotate(input) {
      await deps.assertNotRecursive(input.callerThreadId);
      const existing = requireHook(input);
      const secret = generateHookSecret();
      await writeHookSecret({ pluginDataDir, hookId: existing.id, secret });
      const row = bumpHookSecretVersion(db, {
        hookId: existing.id,
        now: Date.now(),
      });
      if (row === null) throw new Error("Hook not found");
      return automationHookSecretResponseSchema.parse({
        hook: await toResponse(row),
        secret,
      });
    },

    async delete(input) {
      await deps.assertNotRecursive(input.callerThreadId);
      const existing = requireHook(input);
      const users = listEventAutomationsForHook(db, existing.id);
      if (users.length > 0) {
        throw new Error(
          `Hook ${existing.id} is used by ${users.map((user) => user.name).join(", ")}; change or delete those automations first`,
        );
      }
      deleteHook(db, existing.id);
      await deleteHookSecret({ pluginDataDir, hookId: existing.id });
      return { ok: true };
    },

    async test(input) {
      const hook = requireHook(input);
      const kind = input.kind ?? (hook.source === "github" ? "test" : "call");
      if (kind.includes("*"))
        throw new Error("A test event kind cannot contain *");
      const now = Date.now();
      const serialized = JSON.stringify(input.payload);
      const payloadBytes = Buffer.byteLength(serialized, "utf8");
      if (input.dryRun) {
        const verdicts = evaluateAutomationsForEvent(db, {
          hook,
          kind,
          payload: input.payload,
          now,
        });
        return hookTestResponseSchema.parse({
          dryRun: true,
          kind,
          deliveryId: null,
          outcomes: verdicts.map((verdict) => ({
            ...verdict,
            runId: null,
            updatedAt: now,
          })),
          promptPreviews: previewsFor(
            hook,
            {
              id: "evd_preview",
              eventKind: kind,
              receivedAt: now,
              payloadJson: serialized,
              payloadBytes,
              sample: true,
            },
            verdicts
              .filter((verdict) => verdict.outcome !== "filtered")
              .map((verdict) => verdict.automationId),
          ),
        });
      }
      await deps.assertNotRecursive(input.callerThreadId);
      const matched = evaluateAutomationsForEvent(db, {
        hook,
        kind,
        payload: input.payload,
        now,
      }).filter((verdict) => verdict.outcome !== "filtered");
      for (const automation of listEventAutomationsForHook(db, hook.id)) {
        if (
          !matched.some((verdict) => verdict.automationId === automation.id)
        ) {
          continue;
        }
        const execution = parseAutomationExecution(automation.execution);
        if (execution.mode === "agent" && execution.permissionMode === "full") {
          throw new Error(
            `A sample event cannot start ${automation.name}, which has full access. Preview it with a dry run, or send a real signed event.`,
          );
        }
      }
      const result = ingestDelivery(db, {
        hook,
        deliveryKey: `sample-${randomBytes(8).toString("hex")}`,
        kind,
        payload: input.payload,
        payloadBytes,
        now,
        sample: true,
      });
      if (result.duplicate) throw new Error("Sample delivery collided");
      publishAutomationChange(bb, hook.projectId, "automation-runs-changed");
      if (result.outcomes.some((entry) => entry.outcome === "queued")) {
        setTimeout(deps.onQueued, 0);
      }
      return hookTestResponseSchema.parse({
        dryRun: false,
        kind,
        deliveryId: result.deliveryId,
        outcomes: listOutcomesForDelivery(db, result.deliveryId).map(
          outcomeResponse,
        ),
        promptPreviews: [],
      });
    },

    events(input) {
      const cursor = parseEventCursor(input.cursor);
      const limit = input.limit + 1;
      let source: HookRow["source"];
      let rows: DeliveryRow[];
      if (input.automationId !== undefined) {
        const automation = getAutomationForProject(db, {
          projectId: input.projectId,
          automationId: input.automationId,
        });
        if (automation === null) throw new Error("Automation not found");
        const trigger = parseAutomationTrigger(automation.triggerConfig);
        if (trigger.triggerType !== "event") {
          throw new Error("Automation is not triggered by events");
        }
        source = requireHook({
          projectId: input.projectId,
          hookId: trigger.hookId,
        }).source;
        rows = listDeliveriesForAutomation(db, {
          automationId: input.automationId,
          limit,
          cursor,
        });
      } else if (input.hookId !== undefined) {
        source = requireHook({
          projectId: input.projectId,
          hookId: input.hookId,
        }).source;
        rows = listDeliveriesForHook(db, {
          hookId: input.hookId,
          limit,
          cursor,
        });
      } else {
        throw new Error("provide exactly one of automationId or hookId");
      }
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page[page.length - 1];
      return automationEventListResponseSchema.parse({
        events: page.map((row) => summarize(row, source)),
        nextCursor: hasMore && last ? encodeEventCursor(last) : null,
      });
    },

    event(input) {
      const delivery = getDelivery(db, input.deliveryId);
      const hook = delivery === null ? null : getHook(db, delivery.hookId);
      if (
        delivery === null ||
        hook === null ||
        hook.projectId !== input.projectId
      ) {
        throw new Error("Delivery not found");
      }
      const summary = summarize(delivery, hook.source);
      return automationEventDetailSchema.parse({
        ...summary,
        payload:
          delivery.payloadJson === null
            ? null
            : JSON.parse(delivery.payloadJson),
        promptPreviews: previewsFor(
          hook,
          delivery,
          summary.outcomes.map((outcome) => outcome.automationId),
        ),
      });
    },
  };
}
