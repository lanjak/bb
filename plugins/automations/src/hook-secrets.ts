import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOOK_ID_PATTERN } from "./limits.js";

const SECRET_BYTES = 32;

export function hookSecretsDir(pluginDataDir: string): string {
  return join(pluginDataDir, "hook-secrets");
}

function hookSecretPath(pluginDataDir: string, hookId: string): string {
  if (!HOOK_ID_PATTERN.test(hookId)) {
    throw new Error("Invalid hook id");
  }
  return join(hookSecretsDir(pluginDataDir), hookId);
}

export function generateHookSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export async function writeHookSecret(args: {
  pluginDataDir: string;
  hookId: string;
  secret: string;
}): Promise<void> {
  const dir = hookSecretsDir(args.pluginDataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = hookSecretPath(args.pluginDataDir, args.hookId);
  await writeFile(path, args.secret, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readHookSecret(args: {
  pluginDataDir: string;
  hookId: string;
}): Promise<string | null> {
  try {
    const content = await readFile(
      hookSecretPath(args.pluginDataDir, args.hookId),
      "utf8",
    );
    return content.length > 0 ? content : null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function deleteHookSecret(args: {
  pluginDataDir: string;
  hookId: string;
}): Promise<void> {
  await rm(hookSecretPath(args.pluginDataDir, args.hookId), { force: true });
}
