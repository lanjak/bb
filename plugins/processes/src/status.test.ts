import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  cpuSaturated,
  diskStatus,
  memoryStatus,
} from "./status.js";

const GIB = 1024 ** 3;
const memory = (
  usedPercent: number,
  pressure: "normal" | "warn" | "critical" | null = null,
) => ({
  totalBytes: 100,
  usedBytes: usedPercent,
  source: "meminfo" as const,
  pressure,
});

describe("status thresholds", () => {
  it("warns on memory at 90 percent and is critical at 95", () => {
    expect(memoryStatus(memory(89), DEFAULT_THRESHOLDS).status).toBe("ok");
    expect(memoryStatus(memory(90), DEFAULT_THRESHOLDS).status).toBe("warning");
    expect(memoryStatus(memory(96), DEFAULT_THRESHOLDS).status).toBe(
      "critical",
    );
  });

  it("follows the pressure level on macOS, not the percentage", () => {
    expect(memoryStatus(memory(99, "normal"), DEFAULT_THRESHOLDS).status).toBe(
      "ok",
    );
    expect(memoryStatus(memory(10, "warn"), DEFAULT_THRESHOLDS).status).toBe(
      "warning",
    );
    expect(
      memoryStatus(memory(10, "critical"), DEFAULT_THRESHOLDS).status,
    ).toBe("critical");
  });

  it("warns on a disk by percent or by GiB, whichever trips first", () => {
    const disk = (totalGiB: number, freeGiB: number) =>
      diskStatus(
        { totalBytes: totalGiB * GIB, freeBytes: freeGiB * GIB },
        DEFAULT_THRESHOLDS,
      );
    expect(disk(2000, 300).status).toBe("ok");
    expect(disk(2000, 150).status).toBe("ok");
    expect(disk(2000, 9).status).toBe("warning");
    expect(disk(2000, 1.5)).toMatchObject({ status: "critical" });
    expect(disk(400, 30).status).toBe("warning");
    expect(disk(100, 50).status).toBe("ok");
    expect(disk(100, 8)).toEqual({ freePercent: 8, status: "warning" });
    expect(disk(100, 4).status).toBe("critical");
    expect(disk(20, 9).status).toBe("warning");
    expect(disk(20, 1.5).status).toBe("critical");
    expect(
      diskStatus(
        { totalBytes: 400 * GIB, freeBytes: 200 * GIB },
        { ...DEFAULT_THRESHOLDS, diskCriticalFreePercent: 50 },
      ).status,
    ).toBe("critical");
  });

  it("calls CPU saturated only when every reading in the last minute is high, and at least two exist", () => {
    const now = 100_000;
    const high = (at: number) => ({ at, percent: 99 });
    expect(cpuSaturated([high(now - 1000)], now, DEFAULT_THRESHOLDS)).toBe(
      false,
    );
    expect(
      cpuSaturated(
        [high(now - 30_000), high(now - 1000)],
        now,
        DEFAULT_THRESHOLDS,
      ),
    ).toBe(true);
    expect(
      cpuSaturated(
        [high(now - 30_000), { at: now - 10_000, percent: 40 }, high(now)],
        now,
        DEFAULT_THRESHOLDS,
      ),
    ).toBe(false);
    expect(
      cpuSaturated(
        [high(now - 90_000), high(now - 70_000)],
        now,
        DEFAULT_THRESHOLDS,
      ),
    ).toBe(false);
  });
});
