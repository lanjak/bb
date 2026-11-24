import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import type { Db } from "./data.js";
import { adapterFor } from "./event-adapters/index.js";
import { hmacSha256 } from "./event-adapters/signature.js";
import { ingestDelivery } from "./event-ingest.js";
import { readHookSecret } from "./hook-secrets.js";
import { getHook } from "./hooks.js";
import {
  noteFailedVerification,
  recordRejection,
  senderIsBlocked,
  senderKey,
} from "./rejections.js";
import {
  EVENT_BODY_MAX_BYTES,
  EVENT_BODY_READ_TIMEOUT_MS,
  EVENT_RECEIVE_RATE_LIMIT_PER_MINUTE,
  HOOK_ID_PATTERN,
} from "./limits.js";
import { WEBHOOK_ROUTE_PATH } from "./hook-url.js";
import { publishAutomationChange } from "./realtime.js";

const RATE_WINDOW_MS = 60_000;
const DUMMY_KEY = randomBytes(32).toString("base64url");

export interface WebhookRouteDeps {
  bb: Pick<BbPluginApi, "http" | "log" | "realtime">;
  db: Db;
  pluginDataDir: string;
  onQueued: () => void;
  now?: () => number;
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

const DUMMY_HOOK_ID = "hk_AAAAAAAAAAAAAAAAAAAAAA";

async function readCappedBody(context: Context): Promise<Buffer> {
  const declared = context.req.header("content-length");
  if (declared !== undefined && Number(declared) > EVENT_BODY_MAX_BYTES) {
    throw new BodyTooLargeError();
  }
  const stream = context.req.raw.body;
  if (stream === null) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, EVENT_BODY_READ_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new BodyTimeoutError();
      if (done) break;
      total += value.byteLength;
      if (total > EVENT_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (timedOut) throw new BodyTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, total);
}

function parseJsonBody(
  rawBody: Buffer,
): { ok: true; value: unknown } | { ok: false } {
  if (rawBody.length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(rawBody.toString("utf8"));
    return typeof value === "object" && value !== null
      ? { ok: true, value }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function registerWebhookRoute(deps: WebhookRouteDeps): void {
  const now = deps.now ?? Date.now;
  const windows = new Map<string, { startedAt: number; count: number }>();

  function allowRequest(hookId: string, at: number): boolean {
    const current = windows.get(hookId);
    if (current === undefined || at - current.startedAt >= RATE_WINDOW_MS) {
      windows.set(hookId, { startedAt: at, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= EVENT_RECEIVE_RATE_LIMIT_PER_MINUTE;
  }

  deps.bb.http.route(
    "POST",
    WEBHOOK_ROUTE_PATH,
    async (context) => {
      const at = now();
      const hookId = context.req.query("hook") ?? "";
      const hook = HOOK_ID_PATTERN.test(hookId)
        ? getHook(deps.db, hookId)
        : null;

      const sender = senderKey(context.req.raw.headers);
      if (
        hook !== null &&
        senderIsBlocked({ hookId: hook.id, key: sender, now: at })
      ) {
        context.header("Retry-After", "60");
        return context.json({ ok: false, error: "too many failures" }, 429);
      }

      const secret = await readHookSecret({
        pluginDataDir: deps.pluginDataDir,
        hookId: hook === null ? DUMMY_HOOK_ID : hook.id,
      });

      let rawBody: Buffer;
      try {
        rawBody = await readCappedBody(context);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return context.json({ ok: false, error: "body too large" }, 413);
        }
        if (error instanceof BodyTimeoutError) {
          return context.json({ ok: false, error: "body read timed out" }, 408);
        }
        throw error;
      }

      if (hook === null || secret === null) {
        hmacSha256(DUMMY_KEY, rawBody);
        if (hook !== null) {
          noteFailedVerification({ hookId: hook.id, key: sender, now: at });
        }
        return context.json({ ok: false, error: "invalid signature" }, 401);
      }

      const adapter = adapterFor(hook.source);
      const verdict = adapter.verify({
        headers: context.req.raw.headers,
        rawBody,
        secret,
        verification: hook.verification,
        nowMs: at,
      });
      if (!verdict.ok) {
        if (verdict.status === 401) {
          recordRejection(deps.db, { hookId: hook.id, now: at });
          noteFailedVerification({ hookId: hook.id, key: sender, now: at });
        }
        return context.json(
          { ok: false, error: verdict.error },
          verdict.status,
        );
      }

      if (!allowRequest(hook.id, at)) {
        context.header("Retry-After", "60");
        return context.json({ ok: false, error: "rate limited" }, 429);
      }

      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        return context.json(
          { ok: false, error: "body must be a JSON object or array" },
          400,
        );
      }
      if (adapter.isPing({ event: verdict.event })) {
        return context.json({ ok: true, pong: true }, 200);
      }
      const kind = adapter.deriveKind({
        event: verdict.event,
        payload: parsed.value,
      });
      const result = ingestDelivery(deps.db, {
        hook,
        deliveryKey:
          verdict.deliveryKey ?? `rnd-${randomBytes(12).toString("hex")}`,
        kind,
        payload: parsed.value,
        payloadBytes: rawBody.length,
        now: at,
        sample: false,
      });
      if (result.duplicate) {
        return context.json({ ok: true, duplicate: true }, 200);
      }
      publishAutomationChange(
        deps.bb,
        hook.projectId,
        "automation-runs-changed",
      );
      if (result.outcomes.some((entry) => entry.outcome === "queued")) {
        setTimeout(deps.onQueued, 0);
      }
      return context.json(
        {
          ok: true,
          deliveryId: result.deliveryId,
          kind,
          outcomes: result.outcomes.map((entry) => ({
            automationId: entry.automationId,
            outcome: entry.outcome,
          })),
        },
        202,
      );
    },
    { auth: "none" },
  );
}
