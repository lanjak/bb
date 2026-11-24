import { describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import {
  TOOL_TIMEOUT_MS,
  bbRuntimePids,
  createProcessesHostEntry,
  createRunTool,
  listDevServers,
  sampleProcesses,
  singleFlight,
  stopProcess,
  type ProcessesHostDependencies,
} from "./host.js";
import type { ProcessEntry } from "./src/attribute.js";
import { ProcessCpuTracker } from "./src/cpu-tracker.js";
import type { MachineDependencies } from "./src/machine.js";
import { SUPPORTED, type ProcessUsage } from "./src/snapshot.js";

const DAEMON = 100;
const WORKER = 101;
const THREAD = "thr_one";
const STARTED_AT = 1_700_000_000_000;

function entry(
  pid: number,
  ppid: number,
  name: string,
  threadId: string | null,
): [number, ProcessEntry] {
  return [
    pid,
    { pid, ppid, name, threadId, toolCallId: null, launcher: false },
  ];
}

interface Options {
  survivesTerm?: number[];
  reusedAfterTerm?: number[];
  survivesKill?: number[];
}

function createDeps(options: Options = {}) {
  const table = new Map<number, ProcessEntry>([
    entry(1, 0, "systemd", null),
    entry(DAEMON, 1, "node", null),
    entry(WORKER, DAEMON, "node", null),
    entry(110, DAEMON, "node", null),
    entry(120, 110, "claude", THREAD),
    entry(130, 120, "zsh", THREAD),
    entry(140, 130, "npm", THREAD),
    entry(141, 140, "node", THREAD),
    entry(142, 141, "esbuild", THREAD),
    entry(150, 130, "sleep", THREAD),
    entry(900, 1, "postgres", null),
  ]);
  const alive = new Set(table.keys());
  const signals: Array<[number, string]> = [];
  const cpuMs = new Map<number, number>();
  let clock = 0;
  const usageOf = (pid: number): ProcessUsage => ({
    startToken:
      signals.some(([signalled]) => signalled === pid) &&
      options.reusedAfterTerm?.includes(pid)
        ? `${pid}-reused`
        : `tok-${pid}`,
    startedAt: STARTED_AT + pid,
    cpuTimeMs: cpuMs.get(pid) ?? 0,
    rssBytes: pid * 1000,
    command: table.get(pid)?.name === "node" ? "node vite" : null,
  });
  const deps: ProcessesHostDependencies = {
    selfPid: WORKER,
    daemonPid: DAEMON,
    readSnapshot: async () => {
      const present = new Map([...table].filter(([pid]) => alive.has(pid)));
      return {
        table: present,
        sockets: alive.has(141)
          ? [{ pid: 141, port: 5173, address: "127.0.0.1" }]
          : [],
        usage: new Map([...present.keys()].map((pid) => [pid, usageOf(pid)])),
        others: [
          {
            pid: 5000,
            name: "sshd",
            startToken: "s",
            cpuTimeMs: 0,
            rssBytes: 7_000_000,
          },
        ],
        threads: SUPPORTED,
        listeners: SUPPORTED,
      };
    },
    readCwd: async () => "/work/app",
    kill: (pid, signal) => {
      if (!alive.has(pid)) throw new Error("ESRCH");
      if (signal === 0) return;
      signals.push([pid, signal]);
      if (signal === "SIGKILL" && options.survivesKill?.includes(pid)) return;
      if (signal === "SIGKILL" || !options.survivesTerm?.includes(pid))
        alive.delete(pid);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    deps,
    signals,
    alive,
    cpuMs,
    advance: (ms: number) => (clock += ms),
  };
}

const machineDeps = (): MachineDependencies => ({
  platform: "linux",
  now: () => 0,
  cpus: () => [],
  totalmem: () => 1,
  freemem: () => 1,
  loadavg: () => [],
  readText: async () => null,
  run: async () => null,
  statPath: async () => null,
  sleep: async () => {},
  cgroupRoot: "/nonexistent",
  procRoot: "/nonexistent",
});

describe("processes host entry", () => {
  it("lists a thread's server with its command, directory and start", async () => {
    const { deps } = createDeps();
    const harness = experimental_createHostEntryHarness(
      createProcessesHostEntry(deps, machineDeps()),
    );
    await expect(
      harness.experimental_call("list", { threadId: THREAD }),
    ).resolves.toEqual({
      supported: true,
      reason: null,
      servers: [
        {
          threadId: THREAD,
          rootPid: 140,
          startToken: "tok-140",
          startedAt: STARTED_AT + 140,
          command: "node vite",
          cwd: "/work/app",
          ports: [{ port: 5173, address: "127.0.0.1" }],
        },
      ],
    });
  });

  it("reports an unsupported platform with its reason", async () => {
    const harness = experimental_createHostEntryHarness(
      createProcessesHostEntry(null, machineDeps()),
    );
    await expect(
      harness.experimental_call("list", { threadId: null }),
    ).resolves.toMatchObject({ supported: false, servers: [] });
  });

  it("explains why a machine cannot list servers", async () => {
    const { deps } = createDeps();
    const read = deps.readSnapshot;
    deps.readSnapshot = async () => ({
      ...(await read())!,
      listeners: { ok: false, reason: "No listener scan here." },
    });
    const harness = experimental_createHostEntryHarness(
      createProcessesHostEntry(deps, machineDeps()),
    );
    await expect(
      harness.experimental_call("list", { threadId: null }),
    ).resolves.toEqual({
      supported: false,
      reason: "No listener scan here.",
      servers: [],
    });
  });
});

describe("process sampling", () => {
  it("reads twice on the first call and gives CPU from the difference", async () => {
    const { deps, cpuMs, advance } = createDeps();
    const tracker = new ProcessCpuTracker(15_000);
    const reads: number[] = [];
    const read = deps.readSnapshot;
    deps.readSnapshot = async () => {
      reads.push(deps.now());
      if (reads.length <= 2) cpuMs.set(141, reads.length * 500);
      return (await read())!;
    };
    const first = await sampleProcesses(deps, tracker, 3);
    expect(reads).toHaveLength(2);
    expect(first.processes.find((p) => p.pid === 141)?.cpuPercent).toBeCloseTo(
      50,
    );
    advance(5_000);
    cpuMs.set(141, 1_000 + 5_000);
    const second = await sampleProcesses(deps, tracker, 3);
    expect(reads).toHaveLength(3);
    expect(second.processes.find((p) => p.pid === 141)?.cpuPercent).toBeCloseTo(
      100,
    );
  });

  it("gives each process its thread, role and command root, and others read-only", async () => {
    const { deps } = createDeps();
    const sample = await sampleProcesses(
      deps,
      new ProcessCpuTracker(15_000),
      20,
    );
    const byPid = new Map(sample.processes.map((p) => [p.pid, p]));
    expect(byPid.get(120)).toMatchObject({ role: "agent", rootPid: null });
    expect(byPid.get(130)).toMatchObject({ role: "agent", rootPid: null });
    expect(byPid.get(140)).toMatchObject({ role: "server", rootPid: 140 });
    expect(byPid.get(142)).toMatchObject({ role: "server", rootPid: 140 });
    expect(byPid.get(150)).toMatchObject({ role: "command", rootPid: 150 });
    expect(byPid.get(141)?.ports).toEqual([
      { port: 5173, address: "127.0.0.1" },
    ]);
    expect(byPid.has(900)).toBe(false);
    const others = sample.others.map((other) => other.pid);
    expect(others).toEqual(expect.arrayContaining([110, 900, 5000]));
    expect(others).not.toContain(120);
    expect(others).not.toContain(140);
    expect(sample.threads).toEqual({ supported: true, reason: null });
  });

  it("gives no command line for a process that belongs to no thread", async () => {
    const { deps } = createDeps();
    const sample = await sampleProcesses(
      deps,
      new ProcessCpuTracker(15_000),
      20,
    );
    expect(JSON.stringify(sample.others)).not.toContain("command");
  });

  it("explains an unreadable process table", async () => {
    const { deps } = createDeps();
    deps.readSnapshot = async () => null;
    await expect(
      sampleProcesses(deps, new ProcessCpuTracker(15_000), 3),
    ).resolves.toMatchObject({
      threads: { supported: false },
      processes: [],
    });
  });
});

describe("stopping a command", () => {
  const stop = (pid = 140, token = `tok-${pid}`, threadId = THREAD) => ({
    threadId,
    rootPid: pid,
    startToken: token,
  });

  it("stops the command and everything under it, and nothing else", async () => {
    const { deps, signals, alive } = createDeps();
    await expect(stopProcess(deps, stop())).resolves.toEqual({
      outcome: "stopped",
    });
    expect(signals).toEqual([
      [140, "SIGTERM"],
      [141, "SIGTERM"],
      [142, "SIGTERM"],
    ]);
    expect([...alive].sort((a, b) => a - b)).toEqual([
      1,
      DAEMON,
      WORKER,
      110,
      120,
      130,
      150,
      900,
    ]);
  });

  it("stops a command that listens on no port", async () => {
    const { deps, signals } = createDeps();
    await expect(stopProcess(deps, stop(150))).resolves.toEqual({
      outcome: "stopped",
    });
    expect(signals).toEqual([[150, "SIGTERM"]]);
  });

  it("kills what survives the grace period", async () => {
    const { deps, signals } = createDeps({ survivesTerm: [141] });
    await stopProcess(deps, stop());
    expect(signals).toContainEqual([141, "SIGKILL"]);
    expect(signals).not.toContainEqual([140, "SIGKILL"]);
  });

  it("never offers the agent, its shell, bb or a process of no thread", async () => {
    const { deps, signals } = createDeps();
    for (const pid of [110, 120, 130, 900, DAEMON, WORKER])
      await expect(stopProcess(deps, stop(pid))).resolves.toEqual({
        outcome: "not-found",
      });
    await expect(
      stopProcess(deps, stop(140, "tok-140", "thr_other")),
    ).resolves.toEqual({ outcome: "not-found" });
    expect(signals).toEqual([]);
  });

  it("refuses a process whose start token changed", async () => {
    const { deps, signals } = createDeps();
    await expect(stopProcess(deps, stop(140, "tok-old"))).resolves.toEqual({
      outcome: "changed",
    });
    expect(signals).toEqual([]);
  });

  it("does not kill a process that took a stopped command's pid", async () => {
    const { deps, signals } = createDeps({
      survivesTerm: [141],
      reusedAfterTerm: [141],
    });
    await stopProcess(deps, stop());
    expect(signals).not.toContainEqual([141, "SIGKILL"]);
  });

  it("says when a process survives SIGKILL", async () => {
    const { deps } = createDeps({ survivesTerm: [141], survivesKill: [141] });
    await expect(stopProcess(deps, stop())).resolves.toEqual({
      outcome: "still-running",
    });
  });

  it("refuses to stop anything where threads cannot be read", async () => {
    const { deps, signals } = createDeps();
    const read = deps.readSnapshot;
    deps.readSnapshot = async () => ({
      ...(await read())!,
      threads: { ok: false, reason: "blocked" },
    });
    await expect(stopProcess(deps, stop())).resolves.toEqual({
      outcome: "not-stoppable",
    });
    expect(signals).toEqual([]);
  });
});

describe("host tools", () => {
  it("runs every tool with the C locale, a timeout below the server's, and a kill signal", async () => {
    const calls: Array<{
      command: string;
      options: { timeout: number; killSignal: string; env: NodeJS.ProcessEnv };
    }> = [];
    const run = createRunTool(
      async (command, _args, options) => {
        calls.push({ command, options });
        return { stdout: "ok" };
      },
      { PATH: "/bin", LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8" },
    );
    await expect(run("/bin/ps", ["-ax"])).resolves.toBe("ok");
    expect(calls[0]!.options.env).toEqual({
      PATH: "/bin",
      LANG: "en_AU.UTF-8",
      LC_ALL: "C",
    });
    expect(calls[0]!.options.timeout).toBe(TOOL_TIMEOUT_MS);
    expect(TOOL_TIMEOUT_MS).toBeLessThan(20_000);
    expect(calls[0]!.options.killSignal).toBe("SIGKILL");
  });

  it("gives nothing for a tool that times out or fails, and keeps the output of exit code 1", async () => {
    const timedOut = Object.assign(new Error("timed out"), {
      killed: true,
      signal: "SIGKILL",
    });
    const run = createRunTool(async (command) => {
      if (command === "hang") throw timedOut;
      throw Object.assign(new Error("exit 1"), { code: 1, stdout: "partial" });
    });
    await expect(run("hang", [])).resolves.toBeNull();
    await expect(run("lsof", [])).resolves.toBe("partial");
  });

  it("shares one snapshot read between callers that arrive while it runs", async () => {
    let started = 0;
    let finish: (value: number) => void = () => undefined;
    const read = singleFlight(
      () =>
        new Promise<number>((resolve) => {
          started += 1;
          finish = resolve;
        }),
    );
    const first = read();
    const second = read();
    finish(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    expect(started).toBe(1);
    const third = read();
    finish(8);
    await expect(third).resolves.toBe(8);
    expect(started).toBe(2);
  });
});

describe("bb's own processes", () => {
  function withServer() {
    const { deps, signals } = createDeps();
    const read = deps.readSnapshot;
    deps.readSnapshot = async () => {
      const snapshot = (await read())!;
      snapshot.table.set(800, {
        pid: 800,
        ppid: 1,
        name: "node",
        threadId: THREAD,
        toolCallId: null,
        launcher: false,
      });
      snapshot.usage.set(800, {
        startToken: "tok-800",
        startedAt: STARTED_AT,
        cpuTimeMs: 0,
        rssBytes: 1,
        command: "node /home/me/bb/apps/server/dist/index.js --port 38886",
      });
      snapshot.sockets.push({ pid: 800, port: 38886, address: "127.0.0.1" });
      return snapshot;
    };
    return { deps, signals };
  }

  it("never offers a bb server that carries a thread's id, even as an orphan beside the daemon", async () => {
    const { deps } = withServer();
    const sample = await sampleProcesses(
      deps,
      new ProcessCpuTracker(15_000),
      5,
    );
    expect(sample.processes.find((p) => p.pid === 800)).toMatchObject({
      role: "agent",
      rootPid: null,
    });
    await expect(
      stopProcess(deps, {
        threadId: THREAD,
        rootPid: 800,
        startToken: "tok-800",
      }),
    ).resolves.toEqual({ outcome: "not-found" });
    const listed = await listDevServers(deps, THREAD);
    expect(listed.servers.map((server) => server.rootPid)).not.toContain(800);
  });

  it("recognizes bb's runtime by command line", async () => {
    const { deps } = withServer();
    expect([...bbRuntimePids((await deps.readSnapshot())!)]).toEqual([800]);
  });
});
