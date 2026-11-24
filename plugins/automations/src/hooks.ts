import {
  AUTOMATION_RUN_COLUMNS,
  getAutomation,
  getRunningAutomationRun,
  statement,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { createAutomationRunId, createEventDeliveryId } from "./ids.js";
import {
  EVENT_DEDUPE_RETENTION_MS,
  EVENT_QUEUE_EXPIRY_MS,
  EVENT_RETENTION_MAX_AGE_MS,
  EVENT_RETENTION_MAX_PER_HOOK,
} from "./limits.js";
import type {
  EventOutcome,
  EventSource,
  HookVerification,
} from "./rpc-types.js";

export interface HookRow {
  id: string;
  projectId: string;
  source: EventSource;
  verification: HookVerification;
  name: string;
  secretVersion: number;
  rejectedCount: number;
  lastRejectedAt: number | null;
  createdAt: number;
  rotatedAt: number | null;
}

export interface DeliveryRow {
  id: string;
  hookId: string;
  deliveryKey: string;
  eventKind: string;
  receivedAt: number;
  payloadJson: string | null;
  payloadBytes: number;
  sample: boolean;
}

export interface OutcomeRow {
  deliveryId: string;
  automationId: string;
  outcome: EventOutcome;
  runId: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

const HOOK_COLUMNS = `id, project_id AS projectId, source, verification, name,
  secret_version AS secretVersion, rejected_count AS rejectedCount,
  last_rejected_at AS lastRejectedAt, created_at AS createdAt,
  rotated_at AS rotatedAt`;

const DELIVERY_COLUMNS = `id, hook_id AS hookId, delivery_key AS deliveryKey,
  event_kind AS eventKind, received_at AS receivedAt,
  payload_json AS payloadJson, payload_bytes AS payloadBytes, sample`;

const OUTCOME_COLUMNS = `delivery_id AS deliveryId, automation_id AS automationId,
  outcome, run_id AS runId, reason, created_at AS createdAt,
  updated_at AS updatedAt`;

function hookRow(value: unknown): HookRow {
  return value as HookRow;
}

function deliveryRow(value: unknown): DeliveryRow {
  const raw = value as Omit<DeliveryRow, "sample"> & { sample: 0 | 1 };
  return { ...raw, sample: raw.sample === 1 };
}

function outcomeRow(value: unknown): OutcomeRow {
  return value as OutcomeRow;
}

export function insertHook(
  db: Db,
  args: {
    id: string;
    projectId: string;
    source: EventSource;
    verification: HookVerification;
    name: string;
    now: number;
  },
): HookRow {
  statement(
    db,
    `INSERT INTO automation_hooks (
       id, project_id, source, verification, name, secret_version,
       rejected_count, last_rejected_at, created_at, rotated_at
     ) VALUES (
       @id, @projectId, @source, @verification, @name, 1, 0, NULL, @now, NULL
     )`,
  ).run(args);
  const created = getHook(db, args.id);
  if (!created) throw new Error("failed to create hook");
  return created;
}

export function getHook(db: Db, id: string): HookRow | null {
  const row = statement(
    db,
    `SELECT ${HOOK_COLUMNS} FROM automation_hooks WHERE id = ?`,
  ).get(id);
  return row === undefined ? null : hookRow(row);
}

export function getHookForProject(
  db: Db,
  args: { projectId: string; hookId: string },
): HookRow | null {
  const hook = getHook(db, args.hookId);
  return hook?.projectId === args.projectId ? hook : null;
}

export function listHooksForProject(db: Db, projectId: string): HookRow[] {
  return statement(
    db,
    `SELECT ${HOOK_COLUMNS} FROM automation_hooks
     WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .all(projectId)
    .map(hookRow);
}

export function bumpHookSecretVersion(
  db: Db,
  args: { hookId: string; now: number },
): HookRow | null {
  statement(
    db,
    `UPDATE automation_hooks
       SET secret_version = secret_version + 1, rotated_at = @now
     WHERE id = @hookId`,
  ).run(args);
  return getHook(db, args.hookId);
}

export function deleteHook(db: Db, hookId: string): void {
  db.transaction(() => {
    statement(
      db,
      `DELETE FROM automation_event_outcomes WHERE delivery_id IN (
         SELECT id FROM automation_event_deliveries WHERE hook_id = ?
       )`,
    ).run(hookId);
    statement(
      db,
      `DELETE FROM automation_event_deliveries WHERE hook_id = ?`,
    ).run(hookId);
    statement(db, `DELETE FROM automation_event_dedupe WHERE hook_id = ?`).run(
      hookId,
    );
    statement(db, `DELETE FROM automation_hooks WHERE id = ?`).run(hookId);
  })();
}

export function recordHookRejection(
  db: Db,
  args: { hookId: string; now: number; count: number },
): void {
  statement(
    db,
    `UPDATE automation_hooks
       SET rejected_count = rejected_count + @count, last_rejected_at = @now
     WHERE id = @hookId`,
  ).run(args);
}

export function listEventAutomationsForHook(
  db: Db,
  hookId: string,
): AutomationRow[] {
  return statement(
    db,
    `SELECT id FROM automations
     WHERE trigger_type = 'event'
       AND json_extract(trigger_config, '$.hookId') = ?
     ORDER BY created_at ASC, id ASC`,
  )
    .all(hookId)
    .map((row) => getAutomation(db, (row as { id: string }).id))
    .filter((row): row is AutomationRow => row !== null);
}

export function claimDeliveryKey(
  db: Db,
  args: { hookId: string; deliveryKey: string; now: number },
): boolean {
  return (
    statement(
      db,
      `INSERT OR IGNORE INTO automation_event_dedupe (hook_id, delivery_key, seen_at)
       VALUES (@hookId, @deliveryKey, @now)`,
    ).run(args).changes === 1
  );
}

export function pruneDedupe(db: Db, now: number): number {
  return statement(
    db,
    `DELETE FROM automation_event_dedupe WHERE seen_at < ?`,
  ).run(now - EVENT_DEDUPE_RETENTION_MS).changes;
}

export function insertDelivery(
  db: Db,
  args: {
    hookId: string;
    deliveryKey: string;
    eventKind: string;
    receivedAt: number;
    payloadJson: string | null;
    payloadBytes: number;
    sample: boolean;
  },
): string {
  const id = createEventDeliveryId();
  statement(
    db,
    `INSERT INTO automation_event_deliveries (
       id, hook_id, delivery_key, event_kind, received_at, payload_json,
       payload_bytes, sample
     ) VALUES (
       @id, @hookId, @deliveryKey, @eventKind, @receivedAt, @payloadJson,
       @payloadBytes, @sample
     )`,
  ).run({ ...args, id, sample: args.sample ? 1 : 0 });
  return id;
}

export function getDelivery(db: Db, id: string): DeliveryRow | null {
  const row = statement(
    db,
    `SELECT ${DELIVERY_COLUMNS} FROM automation_event_deliveries WHERE id = ?`,
  ).get(id);
  return row === undefined ? null : deliveryRow(row);
}

export function listDeliveriesForHook(
  db: Db,
  args: {
    hookId: string;
    limit: number;
    cursor: { receivedAt: number; id: string } | null;
  },
): DeliveryRow[] {
  return statement(
    db,
    `SELECT ${DELIVERY_COLUMNS} FROM automation_event_deliveries
     WHERE hook_id = @hookId
       AND (@hasCursor = 0
         OR received_at < @cursorReceivedAt
         OR (received_at = @cursorReceivedAt AND id < @cursorId))
     ORDER BY received_at DESC, id DESC
     LIMIT @limit`,
  )
    .all({
      hookId: args.hookId,
      limit: args.limit,
      hasCursor: args.cursor === null ? 0 : 1,
      cursorReceivedAt: args.cursor?.receivedAt ?? 0,
      cursorId: args.cursor?.id ?? "",
    })
    .map(deliveryRow);
}

export function listDeliveriesForAutomation(
  db: Db,
  args: {
    automationId: string;
    limit: number;
    cursor: { receivedAt: number; id: string } | null;
  },
): DeliveryRow[] {
  return statement(
    db,
    `SELECT d.id AS id, d.hook_id AS hookId, d.delivery_key AS deliveryKey,
            d.event_kind AS eventKind, d.received_at AS receivedAt,
            d.payload_json AS payloadJson, d.payload_bytes AS payloadBytes,
            d.sample AS sample
     FROM automation_event_deliveries d
     JOIN automation_event_outcomes o ON o.delivery_id = d.id
     WHERE o.automation_id = @automationId
       AND (@hasCursor = 0
         OR d.received_at < @cursorReceivedAt
         OR (d.received_at = @cursorReceivedAt AND d.id < @cursorId))
     ORDER BY d.received_at DESC, d.id DESC
     LIMIT @limit`,
  )
    .all({
      automationId: args.automationId,
      limit: args.limit,
      hasCursor: args.cursor === null ? 0 : 1,
      cursorReceivedAt: args.cursor?.receivedAt ?? 0,
      cursorId: args.cursor?.id ?? "",
    })
    .map(deliveryRow);
}

export function insertOutcome(
  db: Db,
  args: {
    deliveryId: string;
    automationId: string;
    outcome: EventOutcome;
    reason: string | null;
    now: number;
  },
): void {
  statement(
    db,
    `INSERT INTO automation_event_outcomes (
       delivery_id, automation_id, outcome, run_id, reason, created_at,
       updated_at
     ) VALUES (
       @deliveryId, @automationId, @outcome, NULL, @reason, @now, @now
     )`,
  ).run(args);
}

export function listOutcomesForDelivery(
  db: Db,
  deliveryId: string,
): OutcomeRow[] {
  return statement(
    db,
    `SELECT ${OUTCOME_COLUMNS} FROM automation_event_outcomes
     WHERE delivery_id = ? ORDER BY created_at ASC, automation_id ASC`,
  )
    .all(deliveryId)
    .map(outcomeRow);
}

export function getOutcome(
  db: Db,
  args: { deliveryId: string; automationId: string },
): OutcomeRow | null {
  const row = statement(
    db,
    `SELECT ${OUTCOME_COLUMNS} FROM automation_event_outcomes
     WHERE delivery_id = ? AND automation_id = ?`,
  ).get(args.deliveryId, args.automationId);
  return row === undefined ? null : outcomeRow(row);
}

export function countRecentEventRuns(
  db: Db,
  args: { automationId: string; since: number },
): number {
  const row = statement(
    db,
    `SELECT COUNT(*) AS count FROM automation_runs
     WHERE automation_id = ? AND trigger = 'event' AND started_at > ?`,
  ).get(args.automationId, args.since) as { count: number };
  return row.count;
}

export function countQueuedOutcomes(db: Db, automationId: string): number {
  const row = statement(
    db,
    `SELECT COUNT(*) AS count FROM automation_event_outcomes
     WHERE automation_id = ? AND outcome = 'queued'`,
  ).get(automationId) as { count: number };
  return row.count;
}

export function oldestQueuedOutcome(
  db: Db,
  automationId: string,
): OutcomeRow | null {
  const row = statement(
    db,
    `SELECT ${OUTCOME_COLUMNS} FROM automation_event_outcomes
     WHERE automation_id = ? AND outcome = 'queued'
     ORDER BY created_at ASC, delivery_id ASC
     LIMIT 1`,
  ).get(automationId);
  return row === undefined ? null : outcomeRow(row);
}

export function listAutomationIdsWithQueuedOutcomes(db: Db): string[] {
  return statement(
    db,
    `SELECT DISTINCT automation_id AS automationId
     FROM automation_event_outcomes WHERE outcome = 'queued'`,
  )
    .all()
    .map((row) => (row as { automationId: string }).automationId);
}

export function setOutcome(
  db: Db,
  args: {
    deliveryId: string;
    automationId: string;
    outcome: EventOutcome;
    reason?: string | null;
    now: number;
  },
): void {
  statement(
    db,
    `UPDATE automation_event_outcomes
       SET outcome = @outcome, reason = @reason, updated_at = @now
     WHERE delivery_id = @deliveryId AND automation_id = @automationId`,
  ).run({ ...args, reason: args.reason ?? null });
}

export function createEventRun(
  db: Db,
  args: {
    automation: AutomationRow;
    deliveryId: string;
    now: number;
  },
): AutomationRunRow | null {
  return db.transaction((): AutomationRunRow | null => {
    if (getRunningAutomationRun(db, args.automation.id)) return null;
    const runId = createAutomationRunId();
    statement(
      db,
      `INSERT INTO automation_runs (
         id, automation_id, run_mode, thread_id, status, trigger,
         event_delivery_id, skip_reason, error, output, exit_code,
         idempotency_key, scheduled_for, started_at, finished_at
       ) VALUES (
         @id, @automationId, @runMode, NULL, 'running', 'event',
         @deliveryId, NULL, NULL, NULL, NULL, NULL, @now, @now, NULL
       )`,
    ).run({
      id: runId,
      automationId: args.automation.id,
      runMode: args.automation.runMode,
      deliveryId: args.deliveryId,
      now: args.now,
    });
    statement(
      db,
      `UPDATE automations SET
         last_run_at = @now,
         run_count = run_count + 1,
         last_run_status = 'running',
         updated_at = @now
       WHERE id = @automationId`,
    ).run({ automationId: args.automation.id, now: args.now });
    setOutcome(db, {
      deliveryId: args.deliveryId,
      automationId: args.automation.id,
      outcome: "started",
      now: args.now,
    });
    statement(
      db,
      `UPDATE automation_event_outcomes SET run_id = @runId
       WHERE delivery_id = @deliveryId AND automation_id = @automationId`,
    ).run({
      runId,
      deliveryId: args.deliveryId,
      automationId: args.automation.id,
    });
    return statement(
      db,
      `SELECT ${AUTOMATION_RUN_COLUMNS} FROM automation_runs WHERE id = ?`,
    ).get(runId) as AutomationRunRow;
  })();
}

export function latestEventRunThread(
  db: Db,
  automationId: string,
): string | null {
  const row = statement(
    db,
    `SELECT thread_id AS threadId FROM automation_runs
     WHERE automation_id = ? AND trigger = 'event' AND thread_id IS NOT NULL
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
  ).get(automationId) as { threadId: string } | undefined;
  return row?.threadId ?? null;
}

export function expireQueuedOutcomes(db: Db, now: number): number {
  return statement(
    db,
    `UPDATE automation_event_outcomes
       SET outcome = 'expired',
           reason = 'queued for more than 24 hours',
           updated_at = @now
     WHERE outcome = 'queued' AND created_at <= @cutoff`,
  ).run({ now, cutoff: now - EVENT_QUEUE_EXPIRY_MS }).changes;
}

export function pruneDeliveries(db: Db, now: number): number {
  return db.transaction(() => {
    const doomed = statement(
      db,
      `SELECT id FROM (
         SELECT d.id AS id, d.received_at AS receivedAt,
                ROW_NUMBER() OVER (
                  PARTITION BY d.hook_id ORDER BY d.received_at DESC, d.id DESC
                ) AS position
         FROM automation_event_deliveries d
       )
       WHERE (position > @keep OR receivedAt < @cutoff)
         AND id NOT IN (
           SELECT delivery_id FROM automation_event_outcomes
           WHERE outcome = 'queued'
         )`,
    )
      .all({
        keep: EVENT_RETENTION_MAX_PER_HOOK,
        cutoff: now - EVENT_RETENTION_MAX_AGE_MS,
      })
      .map((row) => (row as { id: string }).id);
    const removeOutcomes = statement(
      db,
      `DELETE FROM automation_event_outcomes WHERE delivery_id = ?`,
    );
    const removeDelivery = statement(
      db,
      `DELETE FROM automation_event_deliveries WHERE id = ?`,
    );
    for (const id of doomed) {
      removeOutcomes.run(id);
      removeDelivery.run(id);
    }
    return doomed.length;
  })();
}
