import type {
  MachineSampleResult,
  MachineUsage,
  MachineView,
  ProcessRow,
  ProcessesSample,
  SampledProcess,
  ThreadUsage,
  UsageStatus,
} from "../contract.js";
import { SingleFlightCache } from "./cache.js";
import {
  CPU_WINDOW_MS,
  cpuSaturated,
  diskStatus,
  memoryStatus,
  hold,
  percentOf,
  relaxThresholds,
  worst,
  type CpuReading,
  type Thresholds,
} from "./status.js";

export const MACHINE_MAX_AGE_MS = 4_000;
export const PROCESSES_MAX_AGE_MS = 4_000;
const OTHERS_SHOWN = 8;

export interface UsageHost {
  id: string;
  name: string;
  connected: boolean;
}

export interface UsageThread {
  title: string;
  environmentId: string | null;
  deleted: boolean;
}

export interface UsageDependencies {
  hosts(): Promise<UsageHost[]>;
  environmentPaths(hostId: string): Promise<string[]>;
  machineSample(hostId: string, paths: string[]): Promise<MachineSampleResult>;
  processesSample(
    hostId: string,
    includeOthers: number,
  ): Promise<ProcessesSample>;
  thread(threadId: string): Promise<UsageThread | null>;
  environmentHost(environmentId: string): Promise<UsageHost | null>;
  thresholds(): Thresholds;
  now(): number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ThreadUsageResult =
  | { status: "ok"; host: UsageHost; usage: ThreadUsage }
  | {
      status: "no-environment" | "offline" | "unsupported" | "error";
      reason: string;
      host: UsageHost | null;
      usage: null;
    };

function toRow(process: SampledProcess): ProcessRow {
  return {
    pid: process.pid,
    ppid: process.ppid,
    name: process.name,
    command: process.command,
    cpuPercent: process.cpuPercent,
    rssBytes: process.rssBytes,
    startToken: process.startToken,
    startedAt: process.startedAt,
    role: process.role,
    rootPid: process.rootPid,
    stoppable: process.rootPid === process.pid && process.role !== "agent",
    ports: process.ports,
  };
}

function totals(rows: readonly ProcessRow[]) {
  return {
    cpuPercent: rows.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0),
    rssBytes: rows.reduce((sum, row) => sum + row.rssBytes, 0),
    processCount: rows.length,
  };
}

function sortRows(rows: ProcessRow[]): ProcessRow[] {
  return rows.sort(
    (left, right) =>
      (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0) ||
      right.rssBytes - left.rssBytes ||
      left.pid - right.pid,
  );
}

export function offlineMachine(host: UsageHost): MachineView {
  return {
    hostId: host.id,
    name: host.name,
    online: false,
    status: "ok",
    reasons: [],
    platform: null,
    cpuPercent: null,
    cpuCount: null,
    loadAverage: null,
    memory: null,
    cpuSaturated: false,
    cpuStatus: "ok",
    disks: [],
    sampledAt: null,
  };
}

export function createUsageService(deps: UsageDependencies) {
  const machineCache = new SingleFlightCache<string, MachineSampleResult>(
    MACHINE_MAX_AGE_MS,
    deps.now,
  );
  const processCache = new SingleFlightCache<string, ProcessesSample>(
    PROCESSES_MAX_AGE_MS,
    deps.now,
  );
  const history = new Map<string, CpuReading[]>();
  const previous = new Map<string, UsageStatus>();

  async function machineSample(host: UsageHost): Promise<MachineSampleResult> {
    return machineCache.get(host.id, async () => {
      const sample = await deps.machineSample(
        host.id,
        await deps.environmentPaths(host.id),
      );
      const readings = (history.get(host.id) ?? []).filter(
        (reading) => deps.now() - reading.at <= CPU_WINDOW_MS,
      );
      if (sample.cpuPercent !== null)
        readings.push({ at: deps.now(), percent: sample.cpuPercent });
      history.set(host.id, readings);
      return sample;
    });
  }

  function processesSample(host: UsageHost): Promise<ProcessesSample> {
    return processCache.get(host.id, () =>
      deps.processesSample(host.id, OTHERS_SHOWN),
    );
  }

  function view(host: UsageHost, sample: MachineSampleResult): MachineView {
    const base = deps.thresholds();
    const found: Array<{ status: UsageStatus; text: string }> = [];
    let status: UsageStatus = "ok";
    const relaxed = relaxThresholds(base);
    const memoryKey = `${host.id}:memory`;
    const strictMemory = memoryStatus(sample.memory, base);
    const memory = {
      percent: strictMemory.percent,
      status: hold(
        previous.get(memoryKey),
        strictMemory.status,
        memoryStatus(sample.memory, relaxed).status,
      ),
    };
    previous.set(memoryKey, memory.status);
    status = worst(status, memory.status);
    if (memory.status !== "ok")
      found.push({
        status: memory.status,
        text:
          sample.memory.pressure === null
            ? `Memory ${Math.round(memory.percent)}% used`
            : `Memory pressure ${sample.memory.pressure}`,
      });
    const disks = sample.disks.map((disk) => {
      const diskKey = `${host.id}:disk:${disk.path}`;
      const strictDisk = diskStatus(disk, base);
      const result = {
        freePercent: strictDisk.freePercent,
        status: hold(
          previous.get(diskKey),
          strictDisk.status,
          diskStatus(disk, relaxed).status,
        ),
      };
      previous.set(diskKey, result.status);
      status = worst(status, result.status);
      if (result.status !== "ok")
        found.push({
          status: result.status,
          text: `Disk ${disk.label} ${Math.round(result.freePercent)}% free`,
        });
      return {
        label: disk.label,
        path: disk.path,
        totalBytes: disk.totalBytes,
        freeBytes: disk.freeBytes,
        freePercent: result.freePercent,
        status: result.status,
      };
    });
    const cpuKey = `${host.id}:cpu`;
    const readings = history.get(host.id) ?? [];
    const saturated =
      hold(
        previous.get(cpuKey),
        cpuSaturated(readings, deps.now(), base) ? "warning" : "ok",
        cpuSaturated(readings, deps.now(), relaxed) ? "warning" : "ok",
      ) === "warning";
    previous.set(cpuKey, saturated ? "warning" : "ok");
    const cpuStatus: UsageStatus =
      saturated ||
      (sample.cpuPercent !== null &&
        sample.cpuPercent >= base.cpuSaturatedPercent)
        ? "warning"
        : "ok";
    if (saturated) {
      status = worst(status, "warning");
      found.push({ status: "warning", text: "CPU saturated" });
    }
    const reasons = [...found]
      .sort(
        (left, right) =>
          Number(right.status === "critical") -
          Number(left.status === "critical"),
      )
      .map((reason) => reason.text);
    return {
      hostId: host.id,
      name: host.name,
      online: true,
      status,
      reasons,
      platform: sample.platform,
      cpuPercent: sample.cpuPercent,
      cpuCount: sample.cpuCount,
      loadAverage: sample.loadAverage,
      memory: {
        totalBytes: sample.memory.totalBytes,
        usedBytes: sample.memory.usedBytes,
        percent: memory.percent,
        status: memory.status,
        source: sample.memory.source,
        pressure: sample.memory.pressure,
      },
      cpuSaturated: saturated,
      cpuStatus,
      disks,
      sampledAt: sample.sampledAt,
    };
  }

  async function machineView(host: UsageHost): Promise<MachineView> {
    if (!host.connected) return offlineMachine(host);
    try {
      return view(host, await machineSample(host));
    } catch (error) {
      return {
        ...offlineMachine(host),
        online: true,
        reasons: [
          `Could not read this machine: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async function findHost(hostId: string): Promise<UsageHost | null> {
    return (await deps.hosts()).find((host) => host.id === hostId) ?? null;
  }

  async function usageOfThread(
    threadId: string,
    sample: ProcessesSample,
  ): Promise<{ usage: ThreadUsage | null; rows: ProcessRow[] }> {
    const rows = sortRows(
      sample.processes.filter((p) => p.threadId === threadId).map(toRow),
    );
    const thread = await deps.thread(threadId);
    if (thread === null || thread.deleted) return { usage: null, rows };
    return {
      usage: {
        threadId,
        title: thread.title,
        ...totals(rows),
        processes: rows,
      },
      rows,
    };
  }

  return {
    async machines(): Promise<MachineView[]> {
      const hosts = await deps.hosts();
      return Promise.all(hosts.map(machineView));
    },

    async machine(hostId: string): Promise<MachineUsage | null> {
      const host = await findHost(hostId);
      if (host === null) return null;
      const machine = await machineView(host);
      const empty = {
        machine,
        threadsSupported: true,
        threadsReason: null,
        threads: [],
        otherBb: { cpuPercent: 0, rssBytes: 0, processCount: 0, processes: [] },
        others: [],
      } satisfies MachineUsage;
      if (!host.connected || machine.memory === null) return empty;
      let sample: ProcessesSample;
      try {
        sample = await processesSample(host);
      } catch (error) {
        return {
          ...empty,
          threadsSupported: false,
          threadsReason: `Could not read processes: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const threadIds = [...new Set(sample.processes.map((p) => p.threadId))];
      const cpuCount = machine.cpuCount ?? 1;
      const totalBytes = machine.memory.totalBytes;
      const results = await Promise.all(
        threadIds.map(async (threadId) => ({
          threadId,
          ...(await usageOfThread(threadId, sample)),
        })),
      );
      const threads = results
        .flatMap((result) => (result.usage === null ? [] : [result.usage]))
        .sort(
          (left, right) =>
            percentOf(right.cpuPercent, cpuCount * 100) +
              percentOf(right.rssBytes, totalBytes) -
              (percentOf(left.cpuPercent, cpuCount * 100) +
                percentOf(left.rssBytes, totalBytes)) ||
            left.threadId.localeCompare(right.threadId),
        );
      const unknown = sortRows(
        results
          .filter((result) => result.usage === null)
          .flatMap((r) => r.rows),
      );
      return {
        machine,
        threadsSupported: sample.threads.supported,
        threadsReason: sample.threads.reason,
        threads,
        otherBb: { ...totals(unknown), processes: unknown },
        others: [...sample.others]
          .sort(
            (left, right) =>
              (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0) ||
              right.rssBytes - left.rssBytes,
          )
          .slice(0, OTHERS_SHOWN * 2),
      };
    },

    async thread(threadId: string): Promise<ThreadUsageResult> {
      const thread = await deps.thread(threadId);
      if (thread === null || thread.environmentId === null)
        return {
          status: "no-environment",
          reason: "The thread has no environment, so it has no processes.",
          host: null,
          usage: null,
        };
      let host: UsageHost | null;
      try {
        host = await deps.environmentHost(thread.environmentId);
      } catch (error) {
        return {
          status: "error",
          reason: `Could not read the thread's environment: ${errorText(error)}`,
          host: null,
          usage: null,
        };
      }
      if (host === null)
        return {
          status: "no-environment",
          reason: "The environment of the thread has no machine.",
          host: null,
          usage: null,
        };
      if (!host.connected)
        return {
          status: "offline",
          reason: `${host.name} is offline.`,
          host,
          usage: null,
        };
      let sample: ProcessesSample;
      try {
        sample = await processesSample(host);
      } catch (error) {
        return {
          status: "error",
          reason: `Could not read processes on ${host.name}: ${errorText(error)}`,
          host,
          usage: null,
        };
      }
      if (!sample.threads.supported)
        return {
          status: "unsupported",
          reason:
            sample.threads.reason ??
            "This machine cannot attribute processes to threads.",
          host,
          usage: null,
        };
      const rows = sortRows(
        sample.processes.filter((p) => p.threadId === threadId).map(toRow),
      );
      return {
        status: "ok",
        host,
        usage: {
          threadId,
          title: thread.title,
          ...totals(rows),
          processes: rows,
        },
      };
    },

    sampleProcesses: processesSample,
    platformOf(hostId: string): string | null {
      return machineCache.peek(hostId)?.value.platform ?? null;
    },
    refreshProcesses(hostId: string): void {
      processCache.forget(hostId);
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
