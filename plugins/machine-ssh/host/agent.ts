import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.js";

const AGENT_SOCKETS = ["ssh-agent.socket", "gcr/ssh", "keyring/ssh"];

async function isSocket(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isSocket() ?? false;
}

async function discoverAgentSocket(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | null> {
  const shown = await runProcess("systemctl", ["--user", "show-environment"], {
    env,
    signal,
    timeoutMs: 5_000,
  }).catch(() => null);
  const configured = shown?.stdout
    .split("\n")
    .find((line) => line.startsWith("SSH_AUTH_SOCK="))
    ?.slice("SSH_AUTH_SOCK=".length);
  if (configured && (await isSocket(configured))) return configured;
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime) return null;
  for (const name of AGENT_SOCKETS) {
    const path = join(runtime, name);
    if (await isSocket(path)) return path;
  }
  return null;
}

export async function sshEnvironment(
  base: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...base,
    LC_ALL: "C",
    SSH_ASKPASS_REQUIRE: "never",
  };
  if (!env.SSH_AUTH_SOCK && process.platform === "linux") {
    const socket = await discoverAgentSocket(env, signal);
    if (socket !== null) env.SSH_AUTH_SOCK = socket;
  }
  return env;
}
