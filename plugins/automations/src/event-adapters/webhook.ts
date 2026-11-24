import { randomBytes } from "node:crypto";
import {
  EVENT_DELIVERY_KEY_PATTERN,
  TIMESTAMP_WINDOW_SECONDS,
} from "../limits.js";
import type { AdapterVerdict, EventAdapter } from "./types.js";
import {
  hmacSha256,
  INVALID_SIGNATURE,
  parseHex,
  safeEqual,
  sha256Hex,
} from "./signature.js";

const EVENT_HEADER_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/iu;
const TIMESTAMP_PATTERN = /^\d{1,12}$/u;

function readDeliveryAndEvent(headers: Headers):
  | AdapterVerdict
  | {
      deliveryKey: string | null;
      event: string | null;
    } {
  const delivery = headers.get("x-bb-delivery");
  if (delivery !== null && !EVENT_DELIVERY_KEY_PATTERN.test(delivery)) {
    return {
      ok: false,
      status: 400,
      error: "X-Bb-Delivery must match [A-Za-z0-9_.:-]{1,128}",
    };
  }
  const event = headers.get("x-bb-event");
  if (event !== null && !EVENT_HEADER_PATTERN.test(event)) {
    return {
      ok: false,
      status: 400,
      error: "X-Bb-Event must match [a-z0-9_.-]{1,64}",
    };
  }
  return { deliveryKey: delivery, event };
}

export const webhookAdapter: EventAdapter = {
  source: "webhook",

  verify(request) {
    if (request.verification === "token") {
      const presented = Buffer.from(
        request.headers.get("x-bb-webhook-token") ?? "",
        "utf8",
      );
      const expected = Buffer.from(request.secret, "utf8");
      if (
        !safeEqual(
          Buffer.from(sha256Hex(presented), "hex"),
          Buffer.from(sha256Hex(expected), "hex"),
        )
      ) {
        return INVALID_SIGNATURE;
      }
      const meta = readDeliveryAndEvent(request.headers);
      if ("ok" in meta) return meta;
      return {
        ok: true,
        deliveryKey:
          meta.deliveryKey ?? `rnd-${randomBytes(12).toString("hex")}`,
        event: meta.event,
      };
    }
    const timestamp = request.headers.get("x-bb-timestamp") ?? "";
    const signature = SIGNATURE_PATTERN.exec(
      request.headers.get("x-bb-signature") ?? "",
    );
    const signedPrefix = Buffer.from(
      `${timestamp}\n${request.headers.get("x-bb-delivery") ?? ""}\n${request.headers.get("x-bb-event") ?? ""}\n`,
      "utf8",
    );
    const signedBytes = Buffer.concat([signedPrefix, request.rawBody]);
    const expected = hmacSha256(request.secret, signedBytes);
    const provided = parseHex(signature?.[1] ?? "") ?? Buffer.alloc(0);
    const signatureOk = safeEqual(provided, expected);
    const timestampSeconds = TIMESTAMP_PATTERN.test(timestamp)
      ? Number(timestamp)
      : Number.NaN;
    const fresh =
      Number.isFinite(timestampSeconds) &&
      Math.abs(request.nowMs / 1000 - timestampSeconds) <=
        TIMESTAMP_WINDOW_SECONDS;
    if (!signatureOk || !fresh) return INVALID_SIGNATURE;
    const meta = readDeliveryAndEvent(request.headers);
    if ("ok" in meta) return meta;
    return {
      ok: true,
      deliveryKey: meta.deliveryKey ?? `sha-${sha256Hex(signedBytes)}`,
      event: meta.event,
    };
  },

  deriveKind({ event }) {
    return event ?? "call";
  },

  isPing() {
    return false;
  },

  matchView({ payload }) {
    return payload;
  },
};
