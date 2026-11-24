import type {
  AutomationHookResponse,
  EventOutcome,
  EventWhere,
} from "../src/rpc-types";

export function formatWhereClause(clause: EventWhere): string {
  const values = clause.values.join(", ");
  return values === ""
    ? `${clause.path} ${clause.op}`
    : `${clause.path} ${clause.op} ${values}`;
}

export type OutcomeTone = "active" | "quiet" | "problem";

export const EVENT_OUTCOME_LABELS: Record<
  EventOutcome,
  { label: string; tone: OutcomeTone }
> = {
  started: { label: "Started", tone: "active" },
  queued: { label: "Queued", tone: "active" },
  filtered: { label: "Filtered out", tone: "quiet" },
  paused: { label: "Paused", tone: "quiet" },
  rate_limited: { label: "Rate limited", tone: "problem" },
  dropped_queue_full: { label: "Queue full", tone: "problem" },
  expired: { label: "Expired", tone: "problem" },
};

export function formatHookUrlSource(
  source: AutomationHookResponse["urlSource"],
): string {
  switch (source) {
    case "setting":
      return "From the webhookBaseUrl plugin setting";
    case "app-url":
      return "From BB_APP_URL";
    case "loopback":
      return "This machine's loopback address";
  }
}

export function formatHookVerification(hook: AutomationHookResponse): string {
  if (hook.source === "github") {
    return "GitHub signature (X-Hub-Signature-256)";
  }
  return hook.verification === "token"
    ? "Shared token (X-Bb-Webhook-Token)"
    : "HMAC-SHA256 signature (X-Bb-Signature)";
}

export function formatSourceName(
  source: AutomationHookResponse["source"],
): string {
  return source === "github" ? "GitHub" : "Webhook";
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function parseSamplePayload(
  text: string,
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Not valid JSON",
    };
  }
}
