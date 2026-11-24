import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { MAX_MACHINE_PATHS } from "./src/paths.js";
import {
  machineUsageTag,
  serversTag,
  threadUsageTag,
  MACHINES_USAGE_TAG,
  processesHostContract,
  type DevServer,
  type MachineSampleResult,
  type ProcessesSample,
  type SampledProcess,
} from "./contract.js";

const THREAD_ID = "thr_dev";
const listCalls: Array<{ offset?: number; limit: number }> = [];
const GIB = 1024 ** 3;

const SERVER: DevServer = {
  threadId: THREAD_ID,
  rootPid: 140,
  startToken: "tok-140",
  startedAt: 1_700_000_000_000,
  command: "npm run dev",
  cwd: "/work/app",
  ports: [{ port: 5173, address: "127.0.0.1" }],
};

function sampled(
  pid: number,
  overrides: Partial<SampledProcess> = {},
): SampledProcess {
  return {
    pid,
    ppid: 1,
    name: "node",
    command: "node vite --token secret",
    cpuPercent: 10,
    rssBytes: 100_000_000,
    startToken: `tok-${pid}`,
    startedAt: 1_700_000_000_000,
    threadId: THREAD_ID,
    role: "command",
    rootPid: pid,
    ports: [],
    ...overrides,
  };
}

interface Scenario {
  environments?: number;
  environmentId?: string | null;
  hostStatus?: "connected" | "disconnected";
  supported?: boolean;
  outcome?: "stopped" | "changed";
  memoryUsed?: number;
  threadsSupported?: boolean;
  processes?: SampledProcess[];
  cpuPercent?: number;
}

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

function machineSample(scenario: Scenario): MachineSampleResult {
  return {
    platform: "linux",
    cpuPercent: scenario.cpuPercent ?? 20,
    cpuCount: 8,
    loadAverage: [1, 1, 1],
    memory: {
      totalBytes: 16 * GIB,
      usedBytes: scenario.memoryUsed ?? 4 * GIB,
      source: "meminfo",
      pressure: null,
    },
    disks: [
      {
        label: "bb data",
        path: "/home",
        device: "1",
        totalBytes: 400 * GIB,
        freeBytes: 240 * GIB,
      },
    ],
    sampledAt: 1,
  };
}

function processesSample(scenario: Scenario): ProcessesSample {
  return {
    threads: {
      supported: scenario.threadsSupported ?? true,
      reason: scenario.threadsSupported === false ? "blocked" : null,
    },
    processes: scenario.processes ?? [
      sampled(140, { role: "server", cpuPercent: 80 }),
      sampled(150, { cpuPercent: 5, rssBytes: 800_000_000 }),
      sampled(200, {
        threadId: "thr_gone",
        name: "stray",
        cpuPercent: 1,
      }),
    ],
    others: [
      {
        pid: 9,
        name: "Xorg",
        cpuPercent: 3,
        rssBytes: 500_000_000,
        startToken: "x",
      },
    ],
    sampledAt: 1,
  };
}

async function start(scenario: Scenario = {}) {
  const host = createFakePluginHost({
    pluginId: "bb--processes",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr_gone") throw new Error("HTTP 404");
          if (threadId !== THREAD_ID) throw new Error("HTTP 404");
          return makeThreadResponse({
            id: THREAD_ID,
            title: "Build the thing",
            environmentId:
              scenario.environmentId === undefined
                ? "env_1"
                : scenario.environmentId,
          });
        },
      },
      environments: {
        get: async () => ({ id: "env_1", hostId: "host_1" }) as never,
        list: async (args: { offset?: number; limit: number }) => {
          const all = Array.from(
            { length: scenario.environments ?? 1 },
            (_, index) => ({
              id: `env_${index}`,
              path: index === 0 ? "/work/app" : `/work/env-${index}`,
              status: "ready",
              hostLifecycle: "active",
              createdAt: index,
              updatedAt: index === 0 ? 0 : index,
            }),
          );
          listCalls.push(args);
          return all.slice(
            args.offset ?? 0,
            (args.offset ?? 0) + args.limit,
          ) as never;
        },
      },
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host_1",
            name: "laptop",
            status: scenario.hostStatus ?? "connected",
          }),
          makeHostResponse({
            id: "host_2",
            name: "build-box",
            status: "disconnected",
          }),
        ],
      },
      system: {
        config: async () => ({ primaryHostId: "host_1" }) as never,
      },
    },
    experimental_callHostRpc: ({ method, input }) => {
      if (method === "processes.stop")
        return { outcome: scenario.outcome ?? "stopped" };
      if (method === "machine.sample") {
        processesHostContract["machine.sample"].input.parse(input);
        return machineSample(scenario);
      }
      if (method === "processes.sample") return processesSample(scenario);
      const threadId = (input as { threadId: string | null }).threadId;
      const servers = [
        SERVER,
        { ...SERVER, threadId: "thr_elsewhere", rootPid: 7 },
      ];
      return {
        supported: scenario.supported ?? true,
        reason: scenario.supported === false ? "No scan here." : null,
        servers: servers.filter(
          (server) => threadId === null || server.threadId === threadId,
        ),
      };
    },
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

describe("processes server entry: servers", () => {
  it("lists a thread's servers from the machine of its environment", async () => {
    const host = await start();
    await expect(
      host.harness.callRpc("servers.list", { threadId: THREAD_ID }),
    ).resolves.toEqual({
      status: "ok",
      reason: null,
      servers: [
        { ...SERVER, hostId: "host_1", hostName: "laptop", primaryHost: true },
      ],
    });
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "list", input: { threadId: THREAD_ID }, hostId: "host_1" },
    ]);
  });

  it("says why it lists nothing", async () => {
    for (const [scenario, status, reason] of [
      [{ environmentId: null }, "no-environment", null],
      [{ hostStatus: "disconnected" }, "offline", null],
      [{ supported: false }, "unsupported", "No scan here."],
    ] as const) {
      const host = await start(scenario);
      await expect(
        host.harness.callRpc("servers.list", { threadId: THREAD_ID }),
      ).resolves.toEqual({ status, reason, servers: [] });
    }
  });

  it("stops a command with its start token and refreshes the lists", async () => {
    const host = await start();
    await expect(
      host.harness.callRpc("processes.stop", {
        threadId: THREAD_ID,
        rootPid: 140,
        startToken: "tok-140",
      }),
    ).resolves.toEqual({ outcome: "stopped" });
    expect(host.harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "processes.stop",
      input: { threadId: THREAD_ID, rootPid: 140, startToken: "tok-140" },
    });
    expect(
      host.harness.inspection.experimental_rpcInvalidations,
    ).toContainEqual([
      serversTag(THREAD_ID),
      threadUsageTag(THREAD_ID),
      machineUsageTag("host_1"),
    ]);
  });

  it("stops a thread's servers when it is archived or deleted", async () => {
    for (const event of ["thread.archived", "thread.deleted"] as const) {
      const host = await start();
      await host.harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: THREAD_ID, environmentId: "env_1" }),
      });
      expect(
        host.harness.experimental_hostRpcCalls.map((call) => [
          call.method,
          call.input,
        ]),
      ).toEqual([
        ["list", { threadId: THREAD_ID }],
        [
          "processes.stop",
          { threadId: THREAD_ID, rootPid: 140, startToken: "tok-140" },
        ],
      ]);
    }
  });

  it("logs instead of stopping when the thread's machine is offline", async () => {
    const host = await start({ hostStatus: "disconnected" });
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: THREAD_ID, environmentId: "env_1" }),
    });
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
    expect(
      host.harness.inspection.logEntries.map((entry) => entry.message),
    ).toContainEqual(expect.stringContaining("is offline"));
  });

  it("leaves servers running after an archive when the setting is off", async () => {
    const host = await start();
    await host.harness.setSettings({ stopOnArchive: false });
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: THREAD_ID, environmentId: "env_1" }),
    });
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
  });
});

describe("processes server entry: usage", () => {
  it("reads each machine, and an offline machine without calling it", async () => {
    const host = await start();
    const { machines, toasts } = (await host.harness.callRpc(
      "resources.machines",
      {},
    )) as { machines: Array<Record<string, unknown>>; toasts: boolean };
    expect(toasts).toBe(true);
    expect(machines).toMatchObject([
      {
        hostId: "host_1",
        online: true,
        status: "ok",
        cpuPercent: 20,
        memory: { percent: 25 },
        disks: [{ label: "bb data", path: "/home", freePercent: 60 }],
      },
      { hostId: "host_2", online: false, memory: null },
    ]);
    expect(
      host.harness.experimental_hostRpcCalls.map((call) => [
        call.method,
        call.hostId,
      ]),
    ).toEqual([["machine.sample", "host_1"]]);
    expect(host.harness.experimental_hostRpcCalls[0]!.input).toEqual({
      paths: ["/work/app"],
    });
  });

  it("reads a machine with 134 environments, sending the live and newest paths within the host's limit", async () => {
    listCalls.length = 0;
    const host = await start({ environments: 134 });
    const { machines } = (await host.harness.callRpc(
      "resources.machines",
      {},
    )) as { machines: Array<{ online: boolean; memory: unknown }> };
    expect(machines[0]).toMatchObject({ online: true });
    expect(machines[0]!.memory).not.toBeNull();
    expect(listCalls.map((call) => call.offset)).toEqual([0, 100]);
    const sent = host.harness.experimental_hostRpcCalls[0]!.input as {
      paths: string[];
    };
    expect(sent.paths).toHaveLength(MAX_MACHINE_PATHS);
    expect(sent.paths[0]).toBe("/work/env-133");
    expect(sent.paths).not.toContain("/work/env-1");
  });

  it("warns on low memory and shares one host call between readers", async () => {
    const host = await start({ memoryUsed: 15 * GIB });
    const [first, second] = (await Promise.all([
      host.harness.callRpc("resources.machines", {}),
      host.harness.callRpc("resources.machines", {}),
    ])) as Array<{ machines: Array<{ status: string; reasons: string[] }> }>;
    expect(first.machines[0]).toMatchObject({
      status: "warning",
      reasons: ["Memory 94% used"],
    });
    expect(second.machines[0]).toMatchObject({ status: "warning" });
    expect(
      host.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "machine.sample",
      ),
    ).toHaveLength(1);
  });

  it("applies the thresholds from the settings", async () => {
    const host = await start();
    await host.harness.setSettings({ memoryWarnPercent: 20 });
    const result = (await host.harness.callRpc("resources.machines", {})) as {
      machines: Array<{ status: string }>;
    };
    expect(result.machines[0]!.status).toBe("warning");
  });

  it("names the critical reason first", async () => {
    const host = await start({ memoryUsed: 15 * GIB });
    await host.harness.setSettings({ diskCriticalFreePercent: 80 });
    const result = (await host.harness.callRpc("resources.machines", {})) as {
      machines: Array<{ status: string; reasons: string[] }>;
    };
    expect(result.machines[0]).toMatchObject({
      status: "critical",
      reasons: ["Disk bb data 60% free", "Memory 94% used"],
    });
  });

  it("ranks the threads of a machine and keeps unknown threads apart", async () => {
    const host = await start();
    const result = (await host.harness.callRpc("resources.machine", {
      hostId: "host_1",
    })) as {
      threads: Array<{
        threadId: string;
        title: string;
        cpuPercent: number;
        processCount: number;
        processes: Array<{ pid: number; stoppable: boolean }>;
      }>;
      otherBb: { processCount: number; processes: Array<{ pid: number }> };
      others: Array<{ name: string }>;
    };
    expect(result.threads).toMatchObject([
      { threadId: THREAD_ID, title: "Build the thing", processCount: 2 },
    ]);
    expect(result.threads[0]!.cpuPercent).toBe(85);
    expect(
      result.threads[0]!.processes.map((row) => [row.pid, row.stoppable]),
    ).toEqual([
      [140, true],
      [150, true],
    ]);
    expect(result.otherBb.processes.map((row) => row.pid)).toEqual([200]);
    expect(result.others).toMatchObject([{ name: "Xorg" }]);
  });

  it("never marks the agent or a child of a command as stoppable", async () => {
    const host = await start({
      processes: [
        sampled(120, { role: "agent", rootPid: null }),
        sampled(140, { role: "command" }),
        sampled(141, { rootPid: 140, ppid: 140 }),
      ],
    });
    const result = (await host.harness.callRpc("resources.thread", {
      threadId: THREAD_ID,
    })) as {
      usage: { processes: Array<{ pid: number; stoppable: boolean }> };
    };
    expect(
      Object.fromEntries(
        result.usage.processes.map((row) => [row.pid, row.stoppable]),
      ),
    ).toEqual({ 120: false, 140: true, 141: false });
  });

  it("explains a machine that cannot read threads", async () => {
    const host = await start({ threadsSupported: false, processes: [] });
    await expect(
      host.harness.callRpc("resources.thread", { threadId: THREAD_ID }),
    ).resolves.toMatchObject({
      status: "unsupported",
      reason: "blocked",
      usage: null,
    });
    await expect(
      host.harness.callRpc("resources.machine", { hostId: "host_1" }),
    ).resolves.toMatchObject({
      threadsSupported: false,
      threadsReason: "blocked",
    });
  });

  it("says why a thread has no usage", async () => {
    const none = await start({ environmentId: null });
    await expect(
      none.harness.callRpc("resources.thread", { threadId: THREAD_ID }),
    ).resolves.toMatchObject({ status: "no-environment", usage: null });
    const offline = await start({ hostStatus: "disconnected" });
    await expect(
      offline.harness.callRpc("resources.thread", { threadId: THREAD_ID }),
    ).resolves.toMatchObject({ status: "offline", usage: null });
  });

  it("samples nothing until a view reads, and refreshes only while one watches", async () => {
    vi.useFakeTimers();
    const host = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
    const unwatch = host.harness.experimental_watchRpc("resources.machine", {
      input: { hostId: "host_1" },
    });
    const unwatchAll = host.harness.experimental_watchRpc(
      "resources.machines",
      { input: {} },
    );
    const unwatchThread = host.harness.experimental_watchRpc(
      "resources.thread",
      { input: { threadId: THREAD_ID } },
    );
    await vi.advanceTimersByTimeAsync(31_000);
    const invalidations = host.harness.inspection.experimental_rpcInvalidations;
    expect(invalidations).toContainEqual([machineUsageTag("host_1")]);
    expect(invalidations).toContainEqual([MACHINES_USAGE_TAG]);
    expect(invalidations).toContainEqual([threadUsageTag(THREAD_ID)]);
    unwatch();
    unwatchAll();
    unwatchThread();
    const count = invalidations.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.harness.inspection.experimental_rpcInvalidations).toHaveLength(
      count,
    );
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
  });
});

describe("processes server entry: errors", () => {
  it("tells Thread Info why it has no data when the machine cannot be read", async () => {
    const failing = createFakePluginHost({
      pluginId: "bb--processes",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({ id: THREAD_ID, environmentId: "env_1" }),
        },
        environments: {
          get: async () => {
            throw new Error("HTTP 404");
          },
          list: async () => [],
        },
        hosts: { list: async () => [] },
      },
    });
    hosts.push(failing);
    await plugin(failing.bb);
    await expect(
      failing.harness.callRpc("resources.thread", { threadId: THREAD_ID }),
    ).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("HTTP 404"),
      usage: null,
    });
    const cli = await failing.harness.runCli(["thread"], {
      threadId: THREAD_ID,
    });
    expect(cli.stdout).toContain("HTTP 404");
  });
});

describe("processes server entry: CLI", () => {
  it("accepts --limit only with --machine", async () => {
    const host = await start();
    const result = await host.harness.runCli(["usage", "--limit", "3"]);
    expect(result.exitCode).toBe(2);
    const ok = await host.harness.runCli([
      "usage",
      "--machine",
      "laptop",
      "--limit",
      "1",
    ]);
    expect(ok.exitCode).toBe(0);
  });

  it("refuses an RPC stop without a start token", async () => {
    const host = await start();
    await expect(
      host.harness.callRpc("processes.stop", {
        threadId: THREAD_ID,
        rootPid: 140,
        startToken: "",
      }),
    ).rejects.toThrow();
  });

  it("lists servers and stops a command from the CLI", async () => {
    const host = await start();
    const listed = await host.harness.runCli(["servers", THREAD_ID]);
    expect(listed.stdout).toBe(
      `${THREAD_ID}\t140\t127.0.0.1:5173\tnpm run dev\n`,
    );
    const all = await host.harness.runCli(["servers", "--json"]);
    expect(JSON.parse(all.stdout ?? "").servers).toHaveLength(1);
    const stopped = await host.harness.runCli(["stop", "140"], {
      threadId: THREAD_ID,
    });
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(host.harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "processes.stop",
      input: { threadId: THREAD_ID, rootPid: 140, startToken: "tok-140" },
    });
    const missing = await host.harness.runCli(["stop", "999", "--json"], {
      threadId: THREAD_ID,
    });
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      error: { code: "stop_not_found" },
    });
    const noThread = await host.harness.runCli(["stop", "140"]);
    expect(noThread.exitCode).toBe(2);
  });

  it("exits non-zero when the machine did not stop the command", async () => {
    const host = await start({ outcome: "changed" });
    const result = await host.harness.runCli(["stop", "140", "--json"], {
      threadId: THREAD_ID,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "stop_changed" },
    });
  });

  it("shows the machines, then one machine with its threads", async () => {
    const host = await start();
    const all = await host.harness.runCli(["usage"]);
    expect(all.stdout).toContain("laptop\tok\tcpu 20.0%");
    expect(all.stdout).toContain("build-box\toffline");
    const json = JSON.parse(
      (await host.harness.runCli(["usage", "--json"])).stdout ?? "",
    );
    expect(json.machines).toHaveLength(2);
    const one = await host.harness.runCli(["usage", "--machine", "laptop"]);
    expect(one.stdout).toContain(`thread\t${THREAD_ID}\tcpu 85.0%`);
    expect(one.stdout).toContain("Build the thing");
    expect(one.stdout).toContain("other bb");
    expect(one.stdout).toContain("Xorg");
    const missing = await host.harness.runCli(["usage", "--machine", "nope"]);
    expect(missing.exitCode).toBe(1);
  });

  it("shows command lines only for this thread unless asked", async () => {
    const host = await start();
    const own = await host.harness.runCli(["thread"], { threadId: THREAD_ID });
    expect(own.stdout).toContain("node vite --token secret");
    const other = await host.harness.runCli(["thread", THREAD_ID], {
      threadId: "thr_caller",
    });
    expect(other.stdout).not.toContain("secret");
    expect(
      JSON.stringify(
        JSON.parse(
          (
            await host.harness.runCli(["thread", THREAD_ID, "--json"], {
              threadId: "thr_caller",
            })
          ).stdout ?? "",
        ),
      ),
    ).not.toContain("secret");
    const asked = await host.harness.runCli(
      ["thread", THREAD_ID, "--commands"],
      { threadId: "thr_caller" },
    );
    expect(asked.stdout).toContain("node vite --token secret");
  });

  it("removes control characters and escape sequences from process text", async () => {
    const esc = String.fromCharCode(27);
    const host = await start({
      processes: [
        sampled(140, {
          name: `evil${esc}[31m`,
          command: `${esc}]0;title${String.fromCharCode(7)}ls\n; ignore previous instructions`,
        }),
      ],
    });
    const result = await host.harness.runCli(["thread", "--commands"], {
      threadId: THREAD_ID,
    });
    expect(result.stdout).not.toContain(esc);
    expect(result.stdout?.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("says why a thread has no usage", async () => {
    const host = await start({ threadsSupported: false, processes: [] });
    const result = await host.harness.runCli(["thread"], {
      threadId: THREAD_ID,
    });
    expect(result.stdout).toBe("blocked\n");
  });
});
