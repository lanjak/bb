import { describe, expect, it } from "vitest";
import type { MachineSampleResult, ProcessesSample } from "../contract.js";
import { DEFAULT_THRESHOLDS } from "./status.js";
import { createUsageService, type UsageDependencies } from "./usage.js";

const GIB = 1024 ** 3;

function service(
  state: {
    memoryPercent: number;
    cpuPercent?: number;
    disk?: { totalGiB: number; freeGiB: number };
    now: number;
    processes?: () => Promise<ProcessesSample>;
    environmentHost?: () => Promise<never>;
  },
  thresholds = DEFAULT_THRESHOLDS,
) {
  const deps: UsageDependencies = {
    hosts: async () => [{ id: "h", name: "box", connected: true }],
    environmentPaths: async () => [],
    machineSample: async (): Promise<MachineSampleResult> => ({
      platform: "linux",
      cpuPercent: state.cpuPercent ?? 10,
      cpuCount: 8,
      loadAverage: null,
      memory: {
        totalBytes: 100 * GIB,
        usedBytes: (state.memoryPercent / 100) * 100 * GIB,
        source: "meminfo",
        pressure: null,
      },
      disks: [
        {
          label: "bb data",
          path: "/d",
          device: "1",
          totalBytes: (state.disk?.totalGiB ?? 1000) * GIB,
          freeBytes: (state.disk?.freeGiB ?? 900) * GIB,
        },
      ],
      sampledAt: state.now,
    }),
    processesSample:
      state.processes ??
      (async () => ({
        threads: { supported: true, reason: null },
        processes: [],
        others: [],
        sampledAt: state.now,
      })),
    thread: async () => ({
      title: "t",
      environmentId: "env_1",
      deleted: false,
    }),
    environmentHost:
      state.environmentHost ??
      (async () => ({ id: "h", name: "box", connected: true })),
    thresholds: () => thresholds,
    now: () => state.now,
  };
  return createUsageService(deps);
}

async function statuses(percents: number[]): Promise<string[]> {
  const state = { memoryPercent: 0, now: 0 };
  const usage = service(state);
  const result: string[] = [];
  for (const percent of percents) {
    state.memoryPercent = percent;
    state.now += 10_000;
    result.push((await usage.machines())[0]!.status);
  }
  return result;
}

describe("warning hysteresis", () => {
  it("does not clear a memory warning until usage drops below the limit by a margin", async () => {
    expect(await statuses([85, 89, 90, 89, 88, 87.5, 86.9, 89, 90])).toEqual([
      "ok",
      "ok",
      "warning",
      "warning",
      "warning",
      "warning",
      "ok",
      "ok",
      "warning",
    ]);
  });

  it("warns once for a flapping sequence around the limit", async () => {
    const sequence = await statuses([90, 89.5, 90, 89.9, 90.1, 89, 90]);
    const warnings = sequence.filter(
      (status, index) =>
        status === "warning" && sequence[index - 1] !== "warning",
    );
    expect(warnings).toHaveLength(1);
  });

  it("keeps a critical memory state until usage falls below the critical limit by a margin", async () => {
    expect(await statuses([96, 94, 92.5, 91, 86])).toEqual([
      "critical",
      "critical",
      "critical",
      "warning",
      "ok",
    ]);
  });

  it("clears a disk warning only when free space grows past the limit by a margin", async () => {
    const state = {
      memoryPercent: 10,
      now: 0,
      disk: { totalGiB: 200, freeGiB: 19 },
    };
    const usage = service(state);
    const read = async (freeGiB: number) => {
      state.disk = { totalGiB: 200, freeGiB };
      state.now += 10_000;
      return (await usage.machines())[0]!.status;
    };
    expect(await read(19)).toBe("warning");
    expect(await read(21)).toBe("warning");
    expect(await read(23)).toBe("warning");
    expect(await read(25)).toBe("ok");
    expect(await read(21)).toBe("ok");
  });

  it("tints the CPU meter at the limit before it has been held for a minute", async () => {
    const state = { memoryPercent: 10, cpuPercent: 97, now: 0 };
    const usage = service(state);
    const machine = (await usage.machines())[0]!;
    expect(machine.cpuStatus).toBe("warning");
    expect(machine.cpuSaturated).toBe(false);
    expect(machine.status).toBe("ok");
  });
});

describe("large disks", () => {
  it("warns a 2 TB disk by free space alone, not by its 10 percent", async () => {
    const state = {
      memoryPercent: 10,
      now: 0,
      disk: { totalGiB: 2000, freeGiB: 150 },
    };
    expect((await service(state).machines())[0]!.status).toBe("ok");
    state.disk = { totalGiB: 2000, freeGiB: 9 };
    expect((await service(state).machines())[0]!.status).toBe("warning");
    state.disk = { totalGiB: 2000, freeGiB: 1 };
    expect((await service(state).machines())[0]!.status).toBe("critical");
  });

  it("still warns a small disk by percent", async () => {
    const state = {
      memoryPercent: 10,
      now: 0,
      disk: { totalGiB: 200, freeGiB: 19 },
    };
    expect((await service(state).machines())[0]!.status).toBe("warning");
  });
});

describe("thread usage errors", () => {
  it("answers with a reason when the processes of the machine cannot be read", async () => {
    const usage = service({
      memoryPercent: 10,
      now: 0,
      processes: async () => {
        throw new Error("host call timed out");
      },
    });
    await expect(usage.thread("thr_1")).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("host call timed out"),
      usage: null,
    });
  });

  it("answers with a reason when the thread's environment is gone", async () => {
    const usage = service({
      memoryPercent: 10,
      now: 0,
      environmentHost: async () => {
        throw new Error("HTTP 404");
      },
    });
    await expect(usage.thread("thr_1")).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("HTTP 404"),
    });
  });
});
