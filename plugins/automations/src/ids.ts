import { randomBytes, randomInt } from "node:crypto";

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("base64url").toLowerCase()}`;
}

export function createAutomationId(): string {
  return createId("auto");
}

export function createAutomationRunId(): string {
  return createId("arun");
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function createBase62Id(prefix: string, length: number): string {
  let suffix = "";
  for (let index = 0; index < length; index += 1) {
    suffix += BASE62[randomInt(BASE62.length)];
  }
  return `${prefix}_${suffix}`;
}

export function createHookId(): string {
  return createBase62Id("hk", 22);
}

export function createEventDeliveryId(): string {
  return createBase62Id("evd", 22);
}
