import type { MachineSampleResult, UsageStatus } from "../contract.js";

export interface Thresholds {
  memoryWarnPercent: number;
  memoryCriticalPercent: number;
  diskWarnFreePercent: number;
  diskWarnFreeGiB: number;
  diskCriticalFreePercent: number;
  diskCriticalFreeGiB: number;
  cpuSaturatedPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  memoryWarnPercent: 90,
  memoryCriticalPercent: 95,
  diskWarnFreePercent: 10,
  diskWarnFreeGiB: 10,
  diskCriticalFreePercent: 5,
  diskCriticalFreeGiB: 2,
  cpuSaturatedPercent: 95,
};

const GIB = 1024 ** 3;
const RANK: Record<UsageStatus, number> = { ok: 0, warning: 1, critical: 2 };

export const LARGE_DISK_BYTES = 500 * GIB;

export function relaxThresholds(thresholds: Thresholds): Thresholds {
  return {
    memoryWarnPercent: thresholds.memoryWarnPercent - 3,
    memoryCriticalPercent: thresholds.memoryCriticalPercent - 3,
    diskWarnFreePercent: thresholds.diskWarnFreePercent + 2,
    diskWarnFreeGiB: thresholds.diskWarnFreeGiB * 1.25,
    diskCriticalFreePercent: thresholds.diskCriticalFreePercent + 1,
    diskCriticalFreeGiB: thresholds.diskCriticalFreeGiB * 1.25,
    cpuSaturatedPercent: thresholds.cpuSaturatedPercent - 5,
  };
}

export function hold(
  previous: UsageStatus | undefined,
  strict: UsageStatus,
  relaxed: UsageStatus,
): UsageStatus {
  if (previous === undefined) return strict;
  const kept = RANK[relaxed] < RANK[previous] ? relaxed : previous;
  return RANK[kept] > RANK[strict] ? kept : strict;
}

export function worst(left: UsageStatus, right: UsageStatus): UsageStatus {
  return RANK[right] > RANK[left] ? right : left;
}

export function percentOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(100, Math.max(0, (part / whole) * 100));
}

export function diskStatus(
  disk: { totalBytes: number; freeBytes: number },
  thresholds: Thresholds,
): { freePercent: number; status: UsageStatus } {
  const freePercent = percentOf(disk.freeBytes, disk.totalBytes);
  const freeGiB = disk.freeBytes / GIB;
  const byPercent = disk.totalBytes < LARGE_DISK_BYTES;
  const status: UsageStatus =
    (byPercent && freePercent <= thresholds.diskCriticalFreePercent) ||
    freeGiB <= thresholds.diskCriticalFreeGiB
      ? "critical"
      : (byPercent && freePercent <= thresholds.diskWarnFreePercent) ||
          freeGiB <= thresholds.diskWarnFreeGiB
        ? "warning"
        : "ok";
  return { freePercent, status };
}

export function memoryStatus(
  memory: MachineSampleResult["memory"],
  thresholds: Thresholds,
): { percent: number; status: UsageStatus } {
  const percent = percentOf(memory.usedBytes, memory.totalBytes);
  if (memory.pressure === "critical") return { percent, status: "critical" };
  if (memory.pressure === "warn") return { percent, status: "warning" };
  if (memory.pressure === "normal") return { percent, status: "ok" };
  return {
    percent,
    status:
      percent >= thresholds.memoryCriticalPercent
        ? "critical"
        : percent >= thresholds.memoryWarnPercent
          ? "warning"
          : "ok",
  };
}

export interface CpuReading {
  at: number;
  percent: number;
}

export const CPU_WINDOW_MS = 60_000;

export function cpuSaturated(
  history: readonly CpuReading[],
  now: number,
  thresholds: Thresholds,
): boolean {
  const recent = history.filter((reading) => now - reading.at <= CPU_WINDOW_MS);
  return (
    recent.length >= 2 &&
    recent.every((reading) => reading.percent >= thresholds.cpuSaturatedPercent)
  );
}
