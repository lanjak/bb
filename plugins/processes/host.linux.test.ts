import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  sampleProcesses,
  stopProcess,
  type ProcessesHostDependencies,
} from "./host.js";
import { ProcessCpuTracker } from "./src/cpu-tracker.js";
import { readLinuxSnapshot } from "./src/linux.js";

const THREAD = "thr_real_linux";
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
});

const AGENT = `
const { spawn } = require("node:child_process");
const tool = spawn("sh", ["-c", [
  "node -e 'const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(() => b.length, 600000)' &",
  "sh -c 'while :; do :; done' &",
  "wait",
].join("\\n")], { stdio: "ignore" });
process.stdout.write("started\\n");
setTimeout(() => tool.pid, 600000);
`;

const BRIDGE = `
const { spawn } = require("node:child_process");
const agent = spawn(process.execPath, ["-e", ${JSON.stringify(AGENT)}], {
  env: { ...process.env, BB_THREAD_ID: ${JSON.stringify(THREAD)} },
  stdio: ["ignore", "inherit", "inherit"],
});
setTimeout(() => agent.pid, 600000);
`;

function dependencies(): ProcessesHostDependencies {
  const uid = process.getuid!();
  return {
    selfPid: process.pid,
    daemonPid: process.pid,
    readSnapshot: () => readLinuxSnapshot(uid),
    readCwd: async () => null,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

async function startThread(): Promise<ChildProcess> {
  const env = { ...process.env };
  delete env.BB_THREAD_ID;
  const bridge = spawn(process.execPath, ["-e", BRIDGE], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(bridge);
  await new Promise<void>((resolve) =>
    bridge.stdout!.once("data", () => resolve()),
  );
  return bridge;
}

describe.skipIf(process.platform !== "linux")("real Linux processes", () => {
  it("measures a CPU loop and a memory hog under a thread, and stops one without touching the agent", async () => {
    await startThread();
    const deps = dependencies();
    const tracker = new ProcessCpuTracker(15_000);
    let busy: Awaited<ReturnType<typeof sampleProcesses>>["processes"][number];
    let hog: typeof busy;
    for (let attempt = 0; ; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const sample = await sampleProcesses(deps, tracker, 5);
      const mine = sample.processes.filter((p) => p.threadId === THREAD);
      const loop = mine.find(
        (p) => p.name === "sh" && p.role === "command" && p.rootPid === p.pid,
      );
      const memory = mine.find(
        (p) => p.name === "node" && p.rssBytes > 250 * 1024 * 1024,
      );
      if (loop !== undefined && memory !== undefined) {
        busy = loop;
        hog = memory;
        if ((loop.cpuPercent ?? 0) > 50) break;
      }
      if (attempt > 20) throw new Error("the thread's processes never showed");
    }
    expect(busy.cpuPercent).toBeGreaterThan(50);
    expect(hog.rssBytes).toBeGreaterThan(250 * 1024 * 1024);
    const sample = await sampleProcesses(deps, tracker, 5);
    const agent = sample.processes.find(
      (p) => p.threadId === THREAD && p.role === "agent",
    );
    expect(agent).toBeDefined();
    await expect(
      stopProcess(deps, {
        threadId: THREAD,
        rootPid: agent!.pid,
        startToken: agent!.startToken,
      }),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      stopProcess(deps, {
        threadId: THREAD,
        rootPid: busy.pid,
        startToken: busy.startToken,
      }),
    ).resolves.toEqual({ outcome: "stopped" });
    const after = await sampleProcesses(deps, tracker, 5);
    expect(after.processes.some((p) => p.pid === busy.pid)).toBe(false);
    expect(after.processes.some((p) => p.pid === hog.pid)).toBe(true);
    expect(after.processes.some((p) => p.pid === agent!.pid)).toBe(true);
  }, 60_000);
});
