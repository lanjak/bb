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
  onIssuanceFailure?: (failure: OriginalProcessSpawnFailure) => void;
}

export class OriginalProcessSpawnFailure extends Error {
  readonly #descriptorState: { readonly fd: number; readonly attempted: boolean; readonly closed: boolean; readonly failures: readonly unknown[] };
  constructor(
    readonly primary: unknown,
    readonly original: OriginalProcessCustody | undefined,
    descriptorState: { readonly fd: number; readonly attempted: boolean; readonly closed: boolean; readonly failures: readonly unknown[] },
  ) {
    super("Original process issuance remains uncertain.");
    this.#descriptorState = descriptorState;
  }
  get descriptor() {
    return Object.freeze({ ...this.#descriptorState, failures: Object.freeze([...this.#descriptorState.failures]) });
  }
}

const uncertainIssuances = new Set<OriginalProcessSpawnFailure>();

export interface OriginalProcessCustody {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly failures: readonly unknown[];
  cleanup(): Promise<void>;
}

const originals = new WeakMap<ChildProcess, OriginalProcessCustody>();
const originalFailures = new WeakMap<OriginalProcessCustody, unknown[]>();

function retainFailure(original: OriginalProcessCustody, reason: unknown): void {
  originalFailures.get(original)?.push(reason);
}

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
    child, closed,
    get failures(): readonly unknown[] { return Object.freeze([...failures]); },
    cleanup() {
      if (cleanup !== undefined) return cleanup;
      let resolve: () => void = () => undefined;
      let reject: (reason: unknown) => void = () => undefined;
      cleanup = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
      void (async () => {
        let failurePresent = false;
        let failure: unknown;
        try { kill("SIGTERM"); } catch (reason) { failurePresent = true; failure = reason; failures.push(reason); }
        await closed;
        for (const pipe of [child.stdout, child.stderr]) {
          try { pipe?.destroy(); } catch (reason) {
            failures.push(reason);
            if (!failurePresent) { failurePresent = true; failure = reason; }
          }
        }
        if (failurePresent) throw failure;
        if (failures.length !== 0) throw failures[0];
      })().then(resolve, reject);
      return cleanup;
    },
  });
  originals.set(child, original);
  originalFailures.set(original, failures);
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
    retainFailure(original, reason);
    void original.cleanup().catch((cleanupReason: unknown) => { retainFailure(original, cleanupReason); });
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
  const descriptor = { fd, attempted: false, closed: false, failures: [] as unknown[] };
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
    if (original !== undefined) retainFailure(original, reason);
  }
  try { descriptor.attempted = true; closeSync(fd); descriptor.closed = true; }
  catch (reason) {
    descriptor.failures.push(reason);
    if (original !== undefined) retainFailure(original, reason);
    if (!primaryPresent) { primaryPresent = true; primary = reason; }
  }
  if (primaryPresent) {
    const failure = new OriginalProcessSpawnFailure(primary, original, descriptor);
    uncertainIssuances.add(failure);
    if (original !== undefined) void original.cleanup().catch((reason: unknown) => { retainFailure(original, reason); });
    try { args.onIssuanceFailure?.(failure); }
    catch (reason) { descriptor.failures.push(reason); }
    throw primary;
  }
  if (original !== undefined) return original.child;
  throw new Error("Native spawn did not return an original child.");
}
