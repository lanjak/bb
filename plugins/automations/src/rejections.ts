import type { Db } from "./data.js";
import { recordHookRejection } from "./hooks.js";
import { EVENT_REJECTION_WRITE_INTERVAL_MS } from "./limits.js";

const pending = new Map<string, { count: number; lastWriteAt: number }>();

export function recordRejection(
  db: Db,
  args: { hookId: string; now: number },
): void {
  const entry = pending.get(args.hookId) ?? { count: 0, lastWriteAt: 0 };
  entry.count += 1;
  if (args.now - entry.lastWriteAt >= EVENT_REJECTION_WRITE_INTERVAL_MS) {
    recordHookRejection(db, {
      hookId: args.hookId,
      now: args.now,
      count: entry.count,
    });
    entry.count = 0;
    entry.lastWriteAt = args.now;
  }
  pending.set(args.hookId, entry);
}

export function pendingRejections(hookId: string): number {
  return pending.get(hookId)?.count ?? 0;
}

const FAILURE_WINDOW_MS = 60_000;
const FAILURES_PER_FORWARDED_SENDER = 300;
const FAILURES_PER_DIRECT_SENDER = 3_000;
const FAILURE_KEYS_MAX = 2_000;

const failures = new Map<string, { startedAt: number; count: number }>();

export function senderKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded !== undefined && forwarded !== ""
    ? `xff:${forwarded.slice(0, 64)}`
    : "direct";
}

function failureBudget(key: string): number {
  return key === "direct"
    ? FAILURES_PER_DIRECT_SENDER
    : FAILURES_PER_FORWARDED_SENDER;
}

export function senderIsBlocked(args: {
  hookId: string;
  key: string;
  now: number;
}): boolean {
  const entry = failures.get(`${args.hookId}|${args.key}`);
  return (
    entry !== undefined &&
    args.now - entry.startedAt < FAILURE_WINDOW_MS &&
    entry.count >= failureBudget(args.key)
  );
}

export function noteFailedVerification(args: {
  hookId: string;
  key: string;
  now: number;
}): void {
  const id = `${args.hookId}|${args.key}`;
  const entry = failures.get(id);
  if (entry === undefined || args.now - entry.startedAt >= FAILURE_WINDOW_MS) {
    if (failures.size >= FAILURE_KEYS_MAX) {
      const [oldest] = failures.keys();
      if (oldest !== undefined) failures.delete(oldest);
    }
    failures.set(id, { startedAt: args.now, count: 1 });
    return;
  }
  entry.count += 1;
}

export function resetFailureTracking(): void {
  failures.clear();
}
