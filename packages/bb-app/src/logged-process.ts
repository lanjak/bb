import { spawnHostProcess as spawn } from "@bb/process-utils";
import type { ChildProcess } from "node:child_process";
import { spawn as spawnNative } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { internal_DO_NOT_USE_assertManagedRootAdmission } from "@bb/config/file-lock";

const MAX_STDIO_LOG_BYTES_AT_SPAWN = 10 * 1024 * 1024;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
  logDir: string;
  logName: "server" | "host-daemon";
  onOriginal?: (original: OriginalProcessCustody) => void;
}

export interface OriginalProcessCustody {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly failures: unknown[];
  cleanup(): Promise<void>;
}

const originals = new WeakMap<ChildProcess, OriginalProcessCustody>();

export function getOriginalProcessCustody(child: ChildProcess): OriginalProcessCustody | undefined {
  return originals.get(child);
}

function retainOriginal(child: ChildProcess): OriginalProcessCustody {
  const failures: unknown[] = [];
  const kill = child.kill.bind(child);
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  child.on("error", (reason: unknown) => { failures.push(reason); });
  let cleanup: Promise<void> | undefined;
  const original = Object.freeze({
    child, closed, failures,
    cleanup() {
      cleanup ??= (async () => {
        let failurePresent = false;
        let failure: unknown;
        try { kill("SIGTERM"); } catch (reason) { failurePresent = true; failure = reason; failures.push(reason); }
        await closed;
        for (const pipe of [child.stdout, child.stderr]) {
          try { pipe?.destroy(); } catch (reason) { failures.push(reason); }
        }
        if (failurePresent) throw failure;
      })();
      return cleanup;
    },
  });
  originals.set(child, original);
  return original;
}

export function spawnProvisionalBootstrap(
  role: "server" | "host-daemon",
  onOriginal: (original: OriginalProcessCustody) => void,
): OriginalProcessCustody {
  const entry = fileURLToPath(new URL("./managed-bootstrap-entry.mjs", import.meta.url));
  const original = retainOriginal(spawnNative(process.execPath, [entry, role], {
    env: {}, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe", "ipc"],
  }));
  try { onOriginal(original); }
  catch (reason) {
    original.failures.push(reason);
    void original.cleanup().catch((cleanupReason: unknown) => { original.failures.push(cleanupReason); });
  }
  return original;
}

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  internal_DO_NOT_USE_assertManagedRootAdmission("launcher log directory and inherited log descriptor");
  mkdirSync(args.logDir, { recursive: true });
  const logPath = join(args.logDir, `${args.logName}-stdio.log`);
  if (
    (statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) >
    MAX_STDIO_LOG_BYTES_AT_SPAWN
  ) {
    renameSync(logPath, join(args.logDir, `${args.logName}-stdio.1.log`));
  }
  const fd = openSync(logPath, "a", 0o600);
  let original: OriginalProcessCustody | undefined;
  let primaryPresent = false;
  let primary: unknown;
  try {
    original = retainOriginal(spawn(args.command, args.args, {
      cwd: process.cwd(),
      env: args.env,
      stdio: args.ipc === true ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
    }));
    args.onOriginal?.(original);
  } catch (reason) {
    primaryPresent = true;
    primary = reason;
    original?.failures.push(reason);
  }
  try { closeSync(fd); }
  catch (reason) {
    if (original !== undefined) original.failures.push(reason);
    else if (!primaryPresent) { primaryPresent = true; primary = reason; }
  }
  if (original !== undefined) {
    if (primaryPresent) void original.cleanup().catch((reason: unknown) => { original.failures.push(reason); });
    return original.child;
  }
  if (primaryPresent) throw primary;
  throw new Error("Native spawn did not return an original child.");
}
