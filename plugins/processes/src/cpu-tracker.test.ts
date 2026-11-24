import { describe, expect, it } from "vitest";
import {
  MachineCpuTracker,
  ProcessCpuTracker,
  sumCpuTimes,
} from "./cpu-tracker.js";

describe("ProcessCpuTracker", () => {
  it("gives the share of one core used between two readings", () => {
    const tracker = new ProcessCpuTracker(15_000);
    expect(
      tracker.record([{ key: "1:a", cpuTimeMs: 1000 }], 0).get("1:a"),
    ).toBe(null);
    expect(
      tracker.record([{ key: "1:a", cpuTimeMs: 3500 }], 5_000).get("1:a"),
    ).toBe(50);
    expect(
      tracker.record([{ key: "1:a", cpuTimeMs: 13_500 }], 10_000).get("1:a"),
    ).toBe(200);
  });

  it("does not carry a reading over to a process that reused the pid", () => {
    const tracker = new ProcessCpuTracker(15_000);
    tracker.record([{ key: "1:old", cpuTimeMs: 90_000 }], 0);
    expect(
      tracker.record([{ key: "1:new", cpuTimeMs: 10 }], 5_000).get("1:new"),
    ).toBeNull();
  });

  it("gives no value for readings too close together, and forgets processes that exit", () => {
    const tracker = new ProcessCpuTracker(15_000);
    tracker.record(
      [
        { key: "1:a", cpuTimeMs: 0 },
        { key: "2:a", cpuTimeMs: 0 },
      ],
      0,
    );
    expect(
      tracker.record([{ key: "1:a", cpuTimeMs: 10 }], 50).get("1:a"),
    ).toBeNull();
    expect(
      tracker.record([{ key: "2:a", cpuTimeMs: 1000 }], 5_000).get("2:a"),
    ).toBeNull();
  });

  it("says when its last reading is too old to compare", () => {
    const tracker = new ProcessCpuTracker(15_000);
    expect(tracker.hasRecentReading(0)).toBe(false);
    tracker.record([], 1_000);
    expect(tracker.hasRecentReading(10_000)).toBe(true);
    expect(tracker.hasRecentReading(30_000)).toBe(false);
  });
});

describe("MachineCpuTracker", () => {
  const cpu = (user: number, idle: number) => ({
    times: { user, nice: 0, sys: 0, idle, irq: 0 },
  });

  it("gives busy time over total time between two readings", () => {
    const tracker = new MachineCpuTracker(15_000);
    expect(tracker.record(sumCpuTimes([cpu(0, 0), cpu(0, 0)]), 0)).toBeNull();
    expect(
      tracker.record(sumCpuTimes([cpu(150, 50), cpu(50, 150)]), 1000),
    ).toBe(50);
  });

  it("gives nothing when the counters did not move", () => {
    const tracker = new MachineCpuTracker(15_000);
    tracker.record(sumCpuTimes([cpu(5, 5)]), 0);
    expect(tracker.record(sumCpuTimes([cpu(5, 5)]), 1000)).toBeNull();
  });
});
