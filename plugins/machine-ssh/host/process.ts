import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const KILL_GRACE_MS = 2_000;
const CAPTURE_MAX_CHARS = 256 * 1024;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ProcessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${Math.round(timeoutMs / 1000)} s`);
    this.name = "ProcessTimeoutError";
  }
}

export interface RunProcessOptions {
  signal: AbortSignal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  onOutput?: (chunk: string) => void;
}

function tail(text: string): string {
  return text.length > CAPTURE_MAX_CHARS
    ? text.slice(-CAPTURE_MAX_CHARS)
    : text;
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const grouped = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: grouped,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = { stdout: "", stderr: "" };
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal.addEventListener("abort", stop, { once: true });
    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      const accept = (text: string) => {
        if (text === "") return;
        output[stream] = tail(output[stream] + text);
        options.onOutput?.(text);
      };
      child[stream].on("data", (chunk: Buffer) => accept(decoder.write(chunk)));
      child[stream].on("end", () => accept(decoder.end()));
    }
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
    const settle = () => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", stop);
    };
    child.on("error", (error) => {
      settle();
      reject(error);
    });
    child.on("close", (code) => {
      settle();
      if (options.signal.aborted) reject(options.signal.reason);
      else if (timedOut)
        reject(new ProcessTimeoutError(command, options.timeoutMs));
      else resolve({ exitCode: code ?? 255, ...output });
    });
  });
}
