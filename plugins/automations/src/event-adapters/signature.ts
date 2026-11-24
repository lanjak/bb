import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256(key: string, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parseHex(value: string): Buffer | null {
  return /^(?:[0-9a-f]{2})+$/iu.test(value) ? Buffer.from(value, "hex") : null;
}

export const INVALID_SIGNATURE = {
  ok: false,
  status: 401,
  error: "invalid signature",
} as const;
