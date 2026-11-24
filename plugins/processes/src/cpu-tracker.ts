const MIN_WINDOW_MS = 200;

interface Reading {
  cpuTimeMs: number;
  at: number;
}

export class ProcessCpuTracker {
  private previous = new Map<string, Reading>();
  private lastAt: number | null = null;

  constructor(private readonly staleMs: number) {}

  hasRecentReading(now: number): boolean {
    return this.lastAt !== null && now - this.lastAt <= this.staleMs;
  }

  record(
    readings: Iterable<{ key: string; cpuTimeMs: number }>,
    now: number,
  ): Map<string, number | null> {
    const percents = new Map<string, number | null>();
    const next = new Map<string, Reading>();
    for (const { key, cpuTimeMs } of readings) {
      next.set(key, { cpuTimeMs, at: now });
      const before = this.previous.get(key);
      const window = before === undefined ? 0 : now - before.at;
      percents.set(
        key,
        before === undefined || window < MIN_WINDOW_MS
          ? null
          : (Math.max(0, cpuTimeMs - before.cpuTimeMs) / window) * 100,
      );
    }
    this.previous = next;
    this.lastAt = now;
    return percents;
  }
}

export interface CpuTimes {
  busy: number;
  total: number;
}

export function sumCpuTimes(
  cpus: readonly {
    times: Record<"user" | "nice" | "sys" | "idle" | "irq", number>;
  }[],
): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

export class MachineCpuTracker {
  private previous: { times: CpuTimes; at: number } | null = null;

  constructor(private readonly staleMs: number) {}

  hasRecentReading(now: number): boolean {
    return this.previous !== null && now - this.previous.at <= this.staleMs;
  }

  record(times: CpuTimes, now: number): number | null {
    const before = this.previous;
    this.previous = { times, at: now };
    if (before === null) return null;
    const total = times.total - before.times.total;
    if (total <= 0) return null;
    return Math.min(
      100,
      Math.max(0, ((times.busy - before.times.busy) / total) * 100),
    );
  }
}
