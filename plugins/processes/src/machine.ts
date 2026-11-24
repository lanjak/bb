import { readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MachineCpuTracker, sumCpuTimes } from "./cpu-tracker.js";
import type { RunTool } from "./darwin.js";

export type MemorySource = "meminfo" | "cgroup" | "vm_stat" | "os";
export type MemoryPressure = "normal" | "warn" | "critical";

export interface MachineMemory {
  totalBytes: number;
  usedBytes: number;
  source: MemorySource;
  pressure: MemoryPressure | null;
}

export interface MachineDisk {
  path: string;
  device: string;
  totalBytes: number;
  freeBytes: number;
}

export interface MachineSample {
  platform: string;
  cpuPercent: number | null;
  cpuCount: number;
  loadAverage: number[] | null;
  memory: MachineMemory;
  disks: MachineDisk[];
  sampledAt: number;
}

export function parseMeminfo(
  content: string,
): { totalBytes: number; availableBytes: number } | null {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(content);
    return match === null ? null : Number(match[1]) * 1024;
  };
  const totalBytes = read("MemTotal");
  const availableBytes = read("MemAvailable");
  return totalBytes === null || availableBytes === null
    ? null
    : { totalBytes, availableBytes };
}

export function parseVmStat(
  content: string,
): { usedBytes: number; pageSize: number } | null {
  const pageSize = /page size of (\d+) bytes/.exec(content)?.[1];
  if (pageSize === undefined) return null;
  const pages = (label: string): number | null => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(content);
    return match === null ? null : Number(match[1]);
  };
  const active = pages("Pages active");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  if (active === null || wired === null) return null;
  return {
    pageSize: Number(pageSize),
    usedBytes: (active + wired + (compressed ?? 0)) * Number(pageSize),
  };
}

export function parsePressureLevel(
  value: string | undefined,
): MemoryPressure | null {
  switch (value?.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

export function parseCgroupPath(content: string): string | null {
  const line = content.split("\n").find((entry) => entry.startsWith("0::"));
  return line === undefined ? null : line.slice(3).trim();
}

export interface MachineDependencies {
  platform: NodeJS.Platform;
  now(): number;
  cpus(): ReturnType<typeof os.cpus>;
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
  readText(file: string): Promise<string | null>;
  run: RunTool;
  statPath(
    target: string,
  ): Promise<{ device: string; totalBytes: number; freeBytes: number } | null>;
  sleep(ms: number): Promise<void>;
  cgroupRoot: string;
  procRoot: string;
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export function defaultMachineDependencies(run: RunTool): MachineDependencies {
  return {
    platform: process.platform,
    now: () => Date.now(),
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    loadavg: () => os.loadavg(),
    readText: readOptional,
    run,
    statPath: async (target) => {
      try {
        const [info, fsInfo] = await Promise.all([
          stat(target),
          statfs(target),
        ]);
        return {
          device: String(info.dev),
          totalBytes: fsInfo.blocks * fsInfo.bsize,
          freeBytes: fsInfo.bavail * fsInfo.bsize,
        };
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cgroupRoot: "/sys/fs/cgroup",
    procRoot: "/proc",
  };
}

async function linuxMemory(deps: MachineDependencies): Promise<MachineMemory> {
  const meminfo = parseMeminfo(
    (await deps.readText(path.join(deps.procRoot, "meminfo"))) ?? "",
  );
  const physical = meminfo ?? {
    totalBytes: deps.totalmem(),
    availableBytes: deps.freemem(),
  };
  const fallback: MachineMemory = {
    totalBytes: physical.totalBytes,
    usedBytes: physical.totalBytes - physical.availableBytes,
    source: meminfo === null ? "os" : "meminfo",
    pressure: null,
  };
  const cgroupPath = parseCgroupPath(
    (await deps.readText(path.join(deps.procRoot, "self", "cgroup"))) ?? "",
  );
  if (cgroupPath === null) return fallback;
  const directory = path.join(deps.cgroupRoot, cgroupPath);
  const [limit, current, memoryStat] = await Promise.all([
    deps.readText(path.join(directory, "memory.max")),
    deps.readText(path.join(directory, "memory.current")),
    deps.readText(path.join(directory, "memory.stat")),
  ]);
  const max = Number(limit?.trim());
  const used = Number(current?.trim());
  if (
    !Number.isFinite(max) ||
    !Number.isFinite(used) ||
    max <= 0 ||
    max >= physical.totalBytes
  )
    return fallback;
  const inactive = Number(
    /^inactive_file\s+(\d+)$/m.exec(memoryStat ?? "")?.[1] ?? 0,
  );
  return {
    totalBytes: max,
    usedBytes: Math.max(0, used - inactive),
    source: "cgroup",
    pressure: null,
  };
}

async function darwinMemory(deps: MachineDependencies): Promise<MachineMemory> {
  const [vmStat, sysctl] = await Promise.all([
    deps.run("/usr/bin/vm_stat", []),
    deps.run("/usr/sbin/sysctl", [
      "-n",
      "hw.memsize",
      "kern.memorystatus_vm_pressure_level",
    ]),
  ]);
  const parsed = vmStat === null ? null : parseVmStat(vmStat);
  const [memsize, level] = sysctl?.trim().split("\n") ?? [];
  const totalBytes = Number(memsize);
  if (parsed === null || !Number.isFinite(totalBytes) || totalBytes <= 0)
    return osMemory(deps);
  return {
    totalBytes,
    usedBytes: Math.min(totalBytes, parsed.usedBytes),
    source: "vm_stat",
    pressure: parsePressureLevel(level),
  };
}

function osMemory(deps: MachineDependencies): MachineMemory {
  const totalBytes = deps.totalmem();
  return {
    totalBytes,
    usedBytes: totalBytes - deps.freemem(),
    source: "os",
    pressure: null,
  };
}

export async function readMemory(
  deps: MachineDependencies,
): Promise<MachineMemory> {
  if (deps.platform === "linux") return linuxMemory(deps);
  if (deps.platform === "darwin") return darwinMemory(deps);
  return osMemory(deps);
}

export async function readDisks(
  deps: MachineDependencies,
  paths: readonly string[],
): Promise<MachineDisk[]> {
  const disks = new Map<string, MachineDisk>();
  for (const target of paths) {
    const info = await deps.statPath(target);
    if (info === null || disks.has(info.device)) continue;
    disks.set(info.device, {
      path: target,
      device: info.device,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
    });
  }
  return [...disks.values()];
}

const FIRST_READ_GAP_MS = 1_000;
const STALE_CPU_MS = 45_000;

export function createMachineSampler(deps: MachineDependencies) {
  const cpu = new MachineCpuTracker(STALE_CPU_MS);
  return {
    async sample(paths: readonly string[]): Promise<MachineSample> {
      if (!cpu.hasRecentReading(deps.now())) {
        cpu.record(sumCpuTimes(deps.cpus()), deps.now());
        await deps.sleep(FIRST_READ_GAP_MS);
      }
      const cpus = deps.cpus();
      const at = deps.now();
      const cpuPercent = cpu.record(sumCpuTimes(cpus), at);
      const [memory, disks] = await Promise.all([
        readMemory(deps),
        readDisks(deps, paths),
      ]);
      return {
        platform: deps.platform,
        cpuPercent,
        cpuCount: cpus.length,
        loadAverage: deps.platform === "win32" ? null : deps.loadavg(),
        memory,
        disks,
        sampledAt: at,
      };
    },
  };
}
