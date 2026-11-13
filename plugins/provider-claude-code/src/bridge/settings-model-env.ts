import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { claudeConfigDirectory } from "./session-fork.js";

const PROVIDER_MANAGED_BY_HOST_ENV = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";

const MODEL_ENV_KEYS = new Set([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
]);

const USER_SETTINGS_ONLY_KEYS = new Set([
  "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
]);

const settingsEnvSchema = z.object({
  env: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

function isHostManaged(env: NodeJS.ProcessEnv): boolean {
  const value = env[PROVIDER_MANAGED_BY_HOST_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readSettingsModelEnv(
  path: string,
  scope: "user" | "project",
): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = settingsEnvSchema.safeParse(json);
  if (!parsed.success || parsed.data.env === undefined) {
    return {};
  }
  const modelEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data.env)) {
    const name = key.toUpperCase();
    if (!MODEL_ENV_KEYS.has(name)) {
      continue;
    }
    if (scope === "project" && USER_SETTINGS_ONLY_KEYS.has(name)) {
      continue;
    }
    modelEnv[name] = String(value);
  }
  return modelEnv;
}

export function withSettingsModelEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  if (!isHostManaged(env)) {
    return env;
  }
  return {
    ...env,
    ...readSettingsModelEnv(
      join(claudeConfigDirectory(env, cwd), "settings.json"),
      "user",
    ),
    ...readSettingsModelEnv(join(cwd, ".claude", "settings.json"), "project"),
    ...readSettingsModelEnv(
      join(cwd, ".claude", "settings.local.json"),
      "project",
    ),
  };
}
