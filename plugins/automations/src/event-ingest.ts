import {
  parseAutomationExecution,
  parseAutomationTrigger,
  type AutomationRow,
  type Db,
} from "./data.js";
import { adapterFor } from "./event-adapters/index.js";
import { matchEvent } from "./event-match.js";
import { createEventNonce, renderEventPromptBody } from "./event-prompt.js";
import {
  claimDeliveryKey,
  countQueuedOutcomes,
  countRecentEventRuns,
  insertDelivery,
  insertOutcome,
  listEventAutomationsForHook,
  type DeliveryRow,
  type HookRow,
} from "./hooks.js";
import {
  EVENT_QUEUE_DEPTH_MAX,
  EVENT_STORED_PAYLOAD_MAX_BYTES,
} from "./limits.js";
import type { AutomationEventTrigger, EventOutcome } from "./rpc-types.js";

const HOUR_MS = 60 * 60_000;

export interface EventAutomationVerdict {
  automationId: string;
  outcome: EventOutcome;
  reason: string | null;
}

function eventTriggerOf(row: AutomationRow): AutomationEventTrigger | null {
  try {
    const trigger = parseAutomationTrigger(row.triggerConfig);
    return trigger.triggerType === "event" ? trigger : null;
  } catch {
    return null;
  }
}

export function evaluateAutomationsForEvent(
  db: Db,
  args: { hook: HookRow; kind: string; payload: unknown; now: number },
): EventAutomationVerdict[] {
  const view = adapterFor(args.hook.source).matchView({
    payload: args.payload,
    kind: args.kind,
  });
  const verdicts: EventAutomationVerdict[] = [];
  for (const automation of listEventAutomationsForHook(db, args.hook.id)) {
    const trigger = eventTriggerOf(automation);
    if (trigger === null) continue;
    const match = matchEvent({ trigger, kind: args.kind, view });
    if (!match.matched) {
      verdicts.push({
        automationId: automation.id,
        outcome: "filtered",
        reason: match.reason,
      });
    } else if (!automation.enabled) {
      verdicts.push({
        automationId: automation.id,
        outcome: "paused",
        reason: "the automation is paused",
      });
    } else if (
      countRecentEventRuns(db, {
        automationId: automation.id,
        since: args.now - HOUR_MS,
      }) +
        countQueuedOutcomes(db, automation.id) >=
      trigger.maxRunsPerHour
    ) {
      verdicts.push({
        automationId: automation.id,
        outcome: "rate_limited",
        reason: `more than ${trigger.maxRunsPerHour} runs in the last hour`,
      });
    } else if (
      countQueuedOutcomes(db, automation.id) >= EVENT_QUEUE_DEPTH_MAX
    ) {
      verdicts.push({
        automationId: automation.id,
        outcome: "dropped_queue_full",
        reason: `${EVENT_QUEUE_DEPTH_MAX} events are already waiting`,
      });
    } else {
      verdicts.push({
        automationId: automation.id,
        outcome: "queued",
        reason: null,
      });
    }
  }
  return verdicts;
}

export type IngestResult =
  | { duplicate: true }
  | {
      duplicate: false;
      deliveryId: string;
      outcomes: EventAutomationVerdict[];
    };

export function ingestDelivery(
  db: Db,
  args: {
    hook: HookRow;
    deliveryKey: string;
    kind: string;
    payload: unknown;
    payloadBytes: number;
    now: number;
    sample: boolean;
  },
): IngestResult {
  const serialized = JSON.stringify(args.payload);
  const payloadJson =
    Buffer.byteLength(serialized, "utf8") > EVENT_STORED_PAYLOAD_MAX_BYTES
      ? null
      : serialized;
  return db.transaction((): IngestResult => {
    if (
      !claimDeliveryKey(db, {
        hookId: args.hook.id,
        deliveryKey: args.deliveryKey,
        now: args.now,
      })
    ) {
      return { duplicate: true };
    }
    const deliveryId = insertDelivery(db, {
      hookId: args.hook.id,
      deliveryKey: args.deliveryKey,
      eventKind: args.kind,
      receivedAt: args.now,
      payloadJson,
      payloadBytes: args.payloadBytes,
      sample: args.sample,
    });
    const outcomes = evaluateAutomationsForEvent(db, {
      hook: args.hook,
      kind: args.kind,
      payload: args.payload,
      now: args.now,
    });
    for (const verdict of outcomes) {
      insertOutcome(db, {
        deliveryId,
        automationId: verdict.automationId,
        outcome: verdict.outcome,
        reason: verdict.reason,
        now: args.now,
      });
    }
    return { duplicate: false, deliveryId, outcomes };
  })();
}

export function renderEventPromptForAutomation(args: {
  automation: AutomationRow;
  hook: HookRow;
  delivery: Pick<
    DeliveryRow,
    | "id"
    | "eventKind"
    | "receivedAt"
    | "payloadJson"
    | "payloadBytes"
    | "sample"
  >;
  nonce?: string;
}): string | null {
  const trigger = eventTriggerOf(args.automation);
  if (trigger === null) return null;
  const execution = parseAutomationExecution(args.automation.execution);
  if (execution.mode !== "agent") return null;
  return renderEventPromptBody({
    source: args.hook.source,
    verification: args.hook.verification,
    sample: args.delivery.sample,
    kind: args.delivery.eventKind,
    deliveryId: args.delivery.id,
    receivedAt: args.delivery.receivedAt,
    payload:
      args.delivery.payloadJson === null
        ? null
        : JSON.parse(args.delivery.payloadJson),
    payloadBytes: args.delivery.payloadBytes,
    pick: trigger.pick,
    maxBytes: trigger.maxPayloadBytes,
    nonce: args.nonce ?? createEventNonce(),
    ownerPrompt: execution.prompt,
  });
}
