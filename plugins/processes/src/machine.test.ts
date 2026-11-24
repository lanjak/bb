import { describe, expect, it } from "vitest";
import {
  createMachineSampler,
  parseCgroupPath,
  parseMeminfo,
  parsePressureLevel,
  parseVmStat,
  readDisks,
  readMemory,
  type MachineDependencies,
} from "./machine.js";

const GIB = 1024 ** 3;

const MEMINFO = `MemTotal:       16000000 kB
MemFree:         1000000 kB
MemAvailable:    4000000 kB
`;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20000.
Pages active:                            100000.
Pages inactive:                           90000.
Pages wired down:                         50000.
Pages occupied by compressor:             10000.
`;

function dependencies(
  overrides: Partial<MachineDependencies> = {},
  files: Record<string, string> = {},
): MachineDependencies {
  let clock = 0;
  let busy = 0;
  return {
    platform: "linux",
    now: () => clock,
    cpus: () => {
      busy += 50;
      return [
        { times: { user: busy, nice: 0, sys: 0, idle: busy, irq: 0 } },
      ] as never;
    },
    totalmem: () => 8 * GIB,
    freemem: () => 2 * GIB,
    loadavg: () => [0.5, 0.4, 0.3],
    readText: async (file) => files[file] ?? null,
    run: async () => null,
    statPath: async () => null,
    sleep: async (ms) => {
      clock += ms;
    },
    cgroupRoot: "/cg",
    procRoot: "/proc",
    ...overrides,
  };
}

describe("machine readers", () => {
  it("reads total and available memory from meminfo", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 16_000_000 * 1024,
      availableBytes: 4_000_000 * 1024,
    });
    expect(parseMeminfo("nothing")).toBeNull();
  });

  it("counts active, wired and compressed pages as used on macOS", () => {
    expect(parseVmStat(VM_STAT)).toEqual({
      pageSize: 16384,
      usedBytes: 160_000 * 16384,
    });
    expect(parseVmStat("garbage")).toBeNull();
    expect(parsePressureLevel("1\n")).toBe("normal");
    expect(parsePressureLevel("2")).toBe("warn");
    expect(parsePressureLevel("4")).toBe("critical");
    expect(parsePressureLevel(undefined)).toBeNull();
  });

  it("reads the cgroup v2 path", () => {
    expect(parseCgroupPath("0::/user.slice/x.scope\n")).toBe(
      "/user.slice/x.scope",
    );
    expect(parseCgroupPath("12:cpu:/a\n")).toBeNull();
  });

  it("measures Linux memory against MemAvailable", async () => {
    const memory = await readMemory(
      dependencies({}, { "/proc/meminfo": MEMINFO }),
    );
    expect(memory).toMatchObject({
      source: "meminfo",
      totalBytes: 16_000_000 * 1024,
      usedBytes: 12_000_000 * 1024,
    });
  });

  it("measures a container against its cgroup limit, without inactive file cache", async () => {
    const memory = await readMemory(
      dependencies(
        {},
        {
          "/proc/meminfo": MEMINFO,
          "/proc/self/cgroup": "0::/\n",
          "/cg/memory.max": String(2 * GIB),
          "/cg/memory.current": String(1.5 * GIB),
          "/cg/memory.stat": `anon 1\ninactive_file ${GIB / 2}\n`,
        },
      ),
    );
    expect(memory).toEqual({
      source: "cgroup",
      totalBytes: 2 * GIB,
      usedBytes: GIB,
      pressure: null,
    });
  });

  it("ignores a cgroup without a limit or with one above physical memory", async () => {
    for (const max of ["max", String(64 * GIB)]) {
      const memory = await readMemory(
        dependencies(
          {},
          {
            "/proc/meminfo": MEMINFO,
            "/proc/self/cgroup": "0::/\n",
            "/cg/memory.max": max,
            "/cg/memory.current": "1",
          },
        ),
      );
      expect(memory.source).toBe("meminfo");
    }
  });

  it("uses the memory pressure level on macOS", async () => {
    const memory = await readMemory(
      dependencies({
        platform: "darwin",
        run: async (command) =>
          command.endsWith("vm_stat") ? VM_STAT : `${16 * GIB}\n2\n`,
      }),
    );
    expect(memory).toMatchObject({
      source: "vm_stat",
      totalBytes: 16 * GIB,
      usedBytes: 160_000 * 16384,
      pressure: "warn",
    });
  });

  it("falls back to the operating system's numbers", async () => {
    await expect(
      readMemory(dependencies({ platform: "win32" })),
    ).resolves.toMatchObject({
      source: "os",
      totalBytes: 8 * GIB,
      usedBytes: 6 * GIB,
    });
  });

  it("lists one disk for each device", async () => {
    const disks = await readDisks(
      dependencies({
        statPath: async (target) =>
          target === "/gone"
            ? null
            : {
                device: target.startsWith("/work") ? "2" : "1",
                totalBytes: 100,
                freeBytes: 40,
              },
      }),
      ["/data", "/work/a", "/work/b", "/gone", "/data/more"],
    );
    expect(disks.map((disk) => [disk.path, disk.device])).toEqual([
      ["/data", "1"],
      ["/work/a", "2"],
    ]);
  });

  it("samples CPU after a first reading, and loads on non-Windows machines", async () => {
    const deps = dependencies({}, { "/proc/meminfo": MEMINFO });
    const sampler = createMachineSampler(deps);
    const sample = await sampler.sample(["/data"]);
    expect(sample.cpuPercent).toBe(50);
    expect(sample.loadAverage).toEqual([0.5, 0.4, 0.3]);
    expect(sample.cpuCount).toBe(1);
    const windows = createMachineSampler(dependencies({ platform: "win32" }));
    expect((await windows.sample([])).loadAverage).toBeNull();
  });
});
