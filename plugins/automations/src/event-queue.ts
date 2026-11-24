import { experimental_BbHttpError } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  closeAutomationRun,
  getAutomation,
  getRunningAutomationRun,
  listAutomationRuns,
  parseAutomationExecution,
  parseAutomationTrigger,
  type AutomationRow,
  type Db,
} from "./data.js";
import { renderEventPromptForAutomation } from "./event-ingest.js";
import { renderEventPayloadJson } from "./event-prompt.js";
import {
  createEventRun,
  expireQueuedOutcomes,
  getDelivery,
  getHook,
  latestEventRunThread,
  listAutomationIdsWithQueuedOutcomes,
  oldestQueuedOutcome,
  pruneDedupe,
  pruneDeliveries,
  setOutcome,
} from "./hooks.js";
import { publishAutomationChange } from "./realtime.js";
import { readRetryHandoff, type RetryHandoffApi } from "./retry-handoff.js";
import {
  errorMessage,
  executeAgentRun,
  executeScriptRun,
  type AgentRunApi,
  type ScriptRunApi,
} from "./run.js";
import type { ScriptRunScope } from "./script-runner.js";
import { createScriptWorkingDirectoryResolver } from "./working-directory.js";

const threadStateSchema = z
  .object({
    archivedAt: z.number().nullable(),
    deletedAt: z.number().nullable(),
    status: z.enum([
      "pending",
      "idle",
      "active",
      "starting",
      "stopping",
      "error",
    ]),
  })
  .passthrough();

const WORKING_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);

export type EventQueueApi = AgentRunApi &
  ScriptRunApi &
  RetryHandoffApi & {
    sdk: { system: { config(): Promise<{ primaryHostId: string | null }> } };
  };

export interface EventQueueDeps {
  bb: EventQueueApi;
  db: Db;
  pluginDataDir: string;
  scriptRuns: ScriptRunScope;
  hasConnectedHost: () => Promise<boolean>;
}

async function previousEventThreadHolds(
  bb: EventQueueApi,
  db: Db,
  automation: AutomationRow,
  now: number,
): Promise<string | null> {
  if (automation.targetThreadId !== null) return null;
  const threadId = latestEventRunThread(db, automation.id);
  if (threadId === null) return null;
  let thread;
  try {
    thread = threadStateSchema.parse(await bb.sdk.threads.get({ threadId }));
  } catch (error) {
    if (error instanceof experimental_BbHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  if (WORKING_STATUSES.has(thread.status)) {
    return `thread ${threadId} is still working`;
  }
  const [latest] = listAutomationRuns(db, {
    automationId: automation.id,
    limit: 1,
  });
  if (
    latest === undefined ||
    latest.trigger !== "event" ||
    latest.status !== "failed" ||
    latest.threadId !== threadId ||
    latest.finishedAt === null
  ) {
    return null;
  }
  try {
    const handoff = await readRetryHandoff(bb, {
      threadId,
      failedAt: latest.finishedAt,
      now,
    });
    if (handoff.kind === "wait") {
      return `thread ${threadId} may be retried by provider retry`;
    }
    if (handoff.kind === "stand-down" && thread.status === "error") {
      return `provider retry has a retry queued in thread ${threadId}`;
    }
  } catch (error) {
    bb.log.warn(
      `Could not read the retry state of thread ${threadId} for automation ${automation.id}: ${errorMessage(error)}`,
    );
  }
  return null;
}

async function drainAutomation(
  deps: EventQueueDeps,
  automationId: string,
): Promise<void> {
  const { bb, db } = deps;
  const automation = getAutomation(db, automationId);
  if (
    automation === null ||
    !automation.enabled ||
    automation.triggerType !== "event"
  ) {
    return;
  }
  const queued = oldestQueuedOutcome(db, automationId);
  if (queued === null) return;
  if (getRunningAutomationRun(db, automationId) !== null) return;
  const now = Date.now();
  const execution = parseAutomationExecution(automation.execution);
  if (execution.mode === "agent") {
    if (!(await deps.hasConnectedHost())) return;
    const holdReason = await previousEventThreadHolds(bb, db, automation, now);
    if (holdReason !== null) return;
  }
  const delivery = getDelivery(db, queued.deliveryId);
  const trigger = parseAutomationTrigger(automation.triggerConfig);
  const hook = delivery === null ? null : getHook(db, delivery.hookId);
  if (
    delivery === null ||
    hook === null ||
    trigger.triggerType !== "event" ||
    trigger.hookId !== hook.id
  ) {
    setOutcome(db, {
      deliveryId: queued.deliveryId,
      automationId,
      outcome: "expired",
      reason: "the delivery or its hook no longer exists",
      now,
    });
    return;
  }
  const run = createEventRun(db, {
    automation,
    deliveryId: delivery.id,
    now,
  });
  if (run === null) return;
  publishAutomationChange(bb, automation.projectId, [
    "automations-changed",
    "automation-runs-changed",
  ]);
  const onFailure = (error: unknown): void => {
    closeAutomationRun(db, {
      runId: run.id,
      status: "failed",
      error: errorMessage(error),
      now: Date.now(),
    });
  };
  if (execution.mode === "agent") {
    const body = renderEventPromptForAutomation({ automation, hook, delivery });
    if (body === null) {
      onFailure(new Error("The event prompt could not be built"));
      return;
    }
    await executeAgentRun(bb, db, {
      automation,
      run,
      execution,
      onFailure,
      event: { kind: delivery.eventKind, body },
    });
    return;
  }
  const serverHostId = (await bb.sdk.system.config()).primaryHostId;
  void executeScriptRun(bb, db, {
    pluginDataDir: deps.pluginDataDir,
    automation,
    run,
    execution,
    onFailure,
    resolveWorkingDirectory: createScriptWorkingDirectoryResolver({
      sdk: bb.sdk,
      pluginDataDir: deps.pluginDataDir,
      serverHostId,
    }),
    scriptRuns: deps.scriptRuns,
    event: {
      source: hook.source,
      kind: delivery.eventKind,
      deliveryId: delivery.id,
      payloadJson: renderEventPayloadJson({
        payload:
          delivery.payloadJson === null
            ? null
            : JSON.parse(delivery.payloadJson),
        pick: trigger.pick,
      }),
    },
  }).catch((error: unknown) => {
    bb.log.error(
      `Detached event script automation ${automation.id} failed unexpectedly: ${errorMessage(error)}`,
    );
  });
}

export function createEventQueue(deps: EventQueueDeps): {
  drain(): Promise<void>;
  maintain(now?: number): void;
} {
  let draining: Promise<void> | null = null;
  let again = false;

  async function pass(): Promise<void> {
    for (const automationId of listAutomationIdsWithQueuedOutcomes(deps.db)) {
      try {
        await drainAutomation(deps, automationId);
      } catch (error) {
        deps.bb.log.error(
          `Failed to drain event queue of automation ${automationId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  return {
    drain() {
      if (draining !== null) {
        again = true;
        return draining;
      }
      draining = (async () => {
        try {
          do {
            again = false;
            await pass();
          } while (again);
        } finally {
          draining = null;
        }
      })();
      return draining;
    },
    maintain(now = Date.now()) {
      expireQueuedOutcomes(deps.db, now);
      pruneDeliveries(deps.db, now);
      pruneDedupe(deps.db, now);
    },
  };
}

export type EventQueue = ReturnType<typeof createEventQueue>;
