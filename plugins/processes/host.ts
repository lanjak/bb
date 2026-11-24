import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_execHostFile as execHostFile } from "@get-bb/plugin-sdk/process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  processesHostContract,
  type DevServer,
  type MachineSampleResult,
  type ProcessesSample,
  type StopOutcome,
} from "./contract.js";
import {
  BB_RUNTIME_COMMAND,
  attributeProcesses,
  attributeServers,
  descendants,
} from "./src/attribute.js";
import { ProcessCpuTracker } from "./src/cpu-tracker.js";
import {
  readDarwinCwd,
  readDarwinSnapshot,
  type RunTool,
} from "./src/darwin.js";
import {
  DEFAULT_LINUX_CLOCK,
  readLinuxClock,
  readLinuxCwd,
  readLinuxSnapshot,
  type LinuxClock,
} from "./src/linux.js";
import {
  createMachineSampler,
  defaultMachineDependencies,
  type MachineDependencies,
} from "./src/machine.js";
import { describeCapability, type ProcessSnapshot } from "./src/snapshot.js";
import { readWindowsSnapshot } from "./src/win32.js";

const STOP_GRACE_MS = 3_000;
const STOP_KILL_WAIT_MS = 2_000;
const STOP_POLL_MS = 100;
const SAMPLE_GAP_MS = 1_000;
const STALE_READING_MS = 15_000;
const TABLE_UNREADABLE = "The process table could not be read.";

const reportedBlocked = new Set<string>();

function reportBlockedOnce(reason: string): void {
  if (reportedBlocked.has(reason)) return;
  reportedBlocked.add(reason);
  process.stderr.write(`bb processes: ${reason}\n`);
}

export interface ProcessesHostDependencies {
  readonly selfPid: number;
  readonly daemonPid: number;
  readSnapshot(): Promise<ProcessSnapshot | null>;
  readCwd(pid: number): Promise<string | null>;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const TOOL_TIMEOUT_MS = 15_000;

type ExecTool = (
  command: string,
  args: readonly string[],
  options: {
    maxBuffer: number;
    timeout: number;
    killSignal: NodeJS.Signals;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string }>;

export function createRunTool(
  exec: ExecTool,
  environment: NodeJS.ProcessEnv = process.env,
): RunTool {
  return async (command, args) => {
    try {
      return (
        await exec(command, args, {
          maxBuffer: 64 * 1024 * 1024,
          timeout: TOOL_TIMEOUT_MS,
          killSignal: "SIGKILL",
          windowsHide: true,
          env: { ...environment, LC_ALL: "C" },
        })
      ).stdout;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stdout" in error &&
        typeof error.stdout === "string"
      )
        return error.stdout;
      return null;
    }
  };
}

const runTool = createRunTool((command, args, options) =>
  execHostFile(command, args, options),
);

export function singleFlight<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= read().finally(() => {
      pending = null;
    });
    return pending;
  };
}

function defaultDependencies(): ProcessesHostDependencies | null {
  const common = {
    selfPid: process.pid,
    daemonPid: process.ppid,
    kill: (pid: number, signal: NodeJS.Signals | 0) => {
      process.kill(pid, signal);
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  const uid = process.getuid?.();
  if (process.platform === "linux" && uid !== undefined) {
    let clock: Promise<LinuxClock> | null = null;
    return {
      ...common,
      readSnapshot: singleFlight(async () => {
        clock ??= readLinuxClock(runTool).catch(() => DEFAULT_LINUX_CLOCK);
        return readLinuxSnapshot(uid, "/proc", await clock);
      }),
      readCwd: (pid) => readLinuxCwd(pid),
    };
  }
  if (process.platform === "darwin" && uid !== undefined)
    return {
      ...common,
      readSnapshot: singleFlight(() => readDarwinSnapshot(uid, runTool)),
      readCwd: (pid) => readDarwinCwd(pid, runTool),
    };
  if (process.platform === "win32")
    return {
      ...common,
      readSnapshot: singleFlight(() =>
        readWindowsSnapshot(runTool, {
          cacheDir: join(tmpdir(), "bb-processes"),
          onBlocked: reportBlockedOnce,
        }),
      ),
      readCwd: async () => null,
    };
  return null;
}

function alive(deps: ProcessesHostDependencies, pid: number): boolean {
  try {
    deps.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function bbRuntimePids(snapshot: ProcessSnapshot): Set<number> {
  const pids = new Set<number>();
  for (const [pid, usage] of snapshot.usage)
    if (usage.command !== null && BB_RUNTIME_COMMAND.test(usage.command))
      pids.add(pid);
  return pids;
}

function ancestorsOf(snapshot: ProcessSnapshot, pid: number): Set<number> {
  const ancestors = new Set<number>();
  let current = snapshot.table.get(pid);
  while (current !== undefined && !ancestors.has(current.pid)) {
    ancestors.add(current.pid);
    current = snapshot.table.get(current.ppid);
  }
  ancestors.add(pid);
  return ancestors;
}

export async function listDevServers(
  deps: ProcessesHostDependencies,
  threadId: string | null,
): Promise<{ reason: string | null; servers: DevServer[] }> {
  const snapshot = await deps.readSnapshot();
  if (snapshot === null) return { reason: TABLE_UNREADABLE, servers: [] };
  const reason =
    describeCapability(snapshot.threads) ??
    describeCapability(snapshot.listeners);
  if (reason !== null) return { reason, servers: [] };
  const runtimePids = bbRuntimePids(snapshot);
  const attributed = attributeServers({
    table: snapshot.table,
    sockets: snapshot.sockets,
    daemonPid: deps.daemonPid,
    threadId,
  }).filter((server) => !runtimePids.has(server.rootPid));
  const servers = await Promise.all(
    attributed.map(async (server): Promise<DevServer | null> => {
      const usage = snapshot.usage.get(server.rootPid);
      if (usage === undefined) return null;
      const listenerPid = server.pids[0]!;
      return {
        threadId: server.threadId,
        rootPid: server.rootPid,
        startToken: usage.startToken,
        startedAt: usage.startedAt,
        command:
          (snapshot.usage.get(listenerPid) ?? usage).command ??
          snapshot.table.get(listenerPid)?.name ??
          null,
        cwd: await deps.readCwd(server.rootPid),
        ports: server.ports,
      };
    }),
  );
  return {
    reason: null,
    servers: servers.filter((server) => server !== null),
  };
}

function readingsOf(snapshot: ProcessSnapshot) {
  const readings: { key: string; cpuTimeMs: number }[] = [];
  for (const [pid, usage] of snapshot.usage)
    readings.push({
      key: `${pid}:${usage.startToken}`,
      cpuTimeMs: usage.cpuTimeMs,
    });
  for (const other of snapshot.others)
    readings.push({
      key: `${other.pid}:${other.startToken}`,
      cpuTimeMs: other.cpuTimeMs,
    });
  return readings;
}

function topBy<T>(
  items: readonly T[],
  limit: number,
  score: (item: T) => number,
): T[] {
  return [...items]
    .sort((left, right) => score(right) - score(left))
    .slice(0, limit);
}

export async function sampleProcesses(
  deps: ProcessesHostDependencies,
  tracker: ProcessCpuTracker,
  includeOthers: number,
): Promise<ProcessesSample> {
  let snapshot = await deps.readSnapshot();
  if (snapshot === null)
    return {
      threads: { supported: false, reason: TABLE_UNREADABLE },
      processes: [],
      others: [],
      sampledAt: deps.now(),
    };
  if (!tracker.hasRecentReading(deps.now())) {
    tracker.record(readingsOf(snapshot), deps.now());
    await deps.sleep(SAMPLE_GAP_MS);
    snapshot = (await deps.readSnapshot()) ?? snapshot;
  }
  const sampledAt = deps.now();
  const percents = tracker.record(readingsOf(snapshot), sampledAt);
  const percentOf = (pid: number, startToken: string): number | null =>
    percents.get(`${pid}:${startToken}`) ?? null;
  const attribution = attributeProcesses({
    table: snapshot.table,
    sockets: snapshot.sockets,
    daemonPid: deps.daemonPid,
    protectedPids: bbRuntimePids(snapshot),
  });
  const portsByPid = new Map<number, { port: number; address: string }[]>();
  for (const socket of snapshot.sockets) {
    const ports = portsByPid.get(socket.pid) ?? [];
    ports.push({ port: socket.port, address: socket.address });
    portsByPid.set(socket.pid, ports);
  }
  const processes: ProcessesSample["processes"] = [];
  const candidates: ProcessesSample["others"] = snapshot.others.map(
    (other) => ({
      pid: other.pid,
      name: other.name,
      cpuPercent: percentOf(other.pid, other.startToken),
      rssBytes: other.rssBytes,
      startToken: other.startToken,
    }),
  );
  for (const entry of snapshot.table.values()) {
    const usage = snapshot.usage.get(entry.pid);
    if (usage === undefined) continue;
    const attributed = attribution.processes.get(entry.pid);
    const cpuPercent = percentOf(entry.pid, usage.startToken);
    if (attributed === undefined) {
      candidates.push({
        pid: entry.pid,
        name: entry.name,
        cpuPercent,
        rssBytes: usage.rssBytes,
        startToken: usage.startToken,
      });
      continue;
    }
    processes.push({
      pid: entry.pid,
      ppid: entry.ppid,
      name: entry.name,
      command: usage.command,
      cpuPercent,
      rssBytes: usage.rssBytes,
      startToken: usage.startToken,
      startedAt: usage.startedAt,
      threadId: attributed.threadId,
      role: attributed.role,
      rootPid: attributed.rootPid,
      ports: portsByPid.get(entry.pid) ?? [],
    });
  }
  const others = new Map(
    [
      ...topBy(candidates, includeOthers, (item) => item.cpuPercent ?? 0),
      ...topBy(candidates, includeOthers, (item) => item.rssBytes),
    ].map((item) => [item.pid, item]),
  );
  return {
    threads: {
      supported: snapshot.threads.ok,
      reason: describeCapability(snapshot.threads),
    },
    processes,
    others: [...others.values()],
    sampledAt,
  };
}

export async function stopProcess(
  deps: ProcessesHostDependencies,
  input: { threadId: string; rootPid: number; startToken: string },
): Promise<{ outcome: StopOutcome }> {
  const snapshot = await deps.readSnapshot();
  if (snapshot === null || !snapshot.threads.ok)
    return { outcome: "not-stoppable" };
  const attribution = attributeProcesses({
    table: snapshot.table,
    sockets: snapshot.sockets,
    daemonPid: deps.daemonPid,
    protectedPids: bbRuntimePids(snapshot),
  });
  if (attribution.roots.get(input.rootPid) !== input.threadId)
    return { outcome: "not-found" };
  if (snapshot.usage.get(input.rootPid)?.startToken !== input.startToken)
    return { outcome: "changed" };
  const protectedPids = ancestorsOf(snapshot, deps.selfPid);
  protectedPids.add(deps.daemonPid);
  for (const pid of bbRuntimePids(snapshot)) protectedPids.add(pid);
  const targets = descendants(snapshot.table, input.rootPid).filter(
    (pid) => !protectedPids.has(pid),
  );
  if (!targets.includes(input.rootPid)) return { outcome: "not-stoppable" };
  const tokens = new Map(
    targets.map((pid) => [pid, snapshot.usage.get(pid)?.startToken ?? null]),
  );
  for (const pid of targets) {
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  const running = () => targets.filter((pid) => alive(deps, pid));
  for (let waited = 0; waited < STOP_GRACE_MS; waited += STOP_POLL_MS) {
    if (running().length === 0) return { outcome: "stopped" };
    await deps.sleep(STOP_POLL_MS);
  }
  const current = await deps.readSnapshot();
  for (const pid of running()) {
    const token = current?.usage.get(pid)?.startToken ?? null;
    if (token === null || token !== tokens.get(pid)) continue;
    try {
      deps.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  for (let waited = 0; waited < STOP_KILL_WAIT_MS; waited += STOP_POLL_MS) {
    const left = running();
    if (left.length === 0) return { outcome: "stopped" };
    if (waited + STOP_POLL_MS >= STOP_KILL_WAIT_MS) break;
    await deps.sleep(STOP_POLL_MS);
  }
  const remaining = running();
  if (remaining.length === 0) return { outcome: "stopped" };
  const final = await deps.readSnapshot();
  const same = remaining.filter(
    (pid) => final?.usage.get(pid)?.startToken === tokens.get(pid),
  );
  return { outcome: same.length === 0 ? "stopped" : "still-running" };
}

function machineSampleFrom(
  sample: Awaited<
    ReturnType<ReturnType<typeof createMachineSampler>["sample"]>
  >,
): MachineSampleResult {
  return sample;
}

export function createProcessesHostEntry(
  deps: ProcessesHostDependencies | null,
  machineDeps: MachineDependencies = defaultMachineDependencies(runTool),
) {
  const processTracker = new ProcessCpuTracker(STALE_READING_MS);
  const machine = createMachineSampler(machineDeps);
  return experimental_defineHostEntry({
    contract: processesHostContract,
    handlers: {
      list: async ({ threadId }) => {
        if (deps === null)
          return {
            supported: false,
            reason: `Listing servers is not available on ${os.platform()}.`,
            servers: [],
          };
        const listed = await listDevServers(deps, threadId);
        return { supported: listed.reason === null, ...listed };
      },
      "machine.sample": async ({ paths }, context) =>
        machineSampleFrom(
          await machine.sample(
            [...new Set([context.experimental_paths.dataDir, ...paths])],
            context.experimental_paths.dataDir,
          ),
        ),
      "processes.sample": async ({ includeOthers }) =>
        deps === null
          ? {
              threads: {
                supported: false,
                reason: `Process data is not available on ${os.platform()}.`,
              },
              processes: [],
              others: [],
              sampledAt: Date.now(),
            }
          : sampleProcesses(deps, processTracker, includeOthers),
      "processes.stop": (input) =>
        deps === null
          ? { outcome: "not-stoppable" as const }
          : stopProcess(deps, input),
    },
  });
}

export default createProcessesHostEntry(defaultDependencies());
