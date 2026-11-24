// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import {
  processesContract,
  type MachineUsage,
  type MachineView,
  type ProcessRow,
} from "../../contract.js";
import { useResourcesBadge } from "./badge.js";
import { badgeFor, crossings, newToastMemory } from "./badge.js";
import { ResourcesPanel } from "./resources-page.js";
import { ThreadProcessesSection } from "./thread-processes.js";

const GIB = 1024 ** 3;

afterEach(() => {
  cleanup();
});

function machine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    hostId: "host_1",
    name: "laptop",
    online: true,
    status: "ok",
    reasons: [],
    platform: "linux",
    cpuPercent: 42,
    cpuCount: 8,
    loadAverage: [1, 1, 1],
    memory: {
      totalBytes: 16 * GIB,
      usedBytes: 4 * GIB,
      percent: 25,
      status: "ok",
      source: "meminfo",
      pressure: null,
    },
    cpuSaturated: false,
    cpuStatus: "ok",
    disks: [
      {
        path: "/home",
        totalBytes: 500 * GIB,
        freeBytes: 300 * GIB,
        freePercent: 60,
        status: "ok",
      },
    ],
    sampledAt: 1,
    ...overrides,
  };
}

function row(pid: number, overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid,
    ppid: 1,
    name: "python3",
    command: "python3 hog.py",
    cpuPercent: 99,
    rssBytes: 800_000_000,
    startToken: `tok-${pid}`,
    startedAt: null,
    role: "command",
    rootPid: pid,
    stoppable: true,
    ports: [],
    ...overrides,
  };
}

const AGENT = row(120, {
  name: "claude",
  role: "agent",
  rootPid: null,
  stoppable: false,
  cpuPercent: 2,
  rssBytes: 300_000_000,
});

function usage(): MachineUsage {
  const processes = [row(140), AGENT];
  return {
    machine: machine(),
    threadsSupported: true,
    threadsReason: null,
    threads: [
      {
        threadId: "thr_a",
        title: "Heavy thread",
        cpuPercent: 101,
        rssBytes: 1_100_000_000,
        processCount: 2,
        processes,
      },
    ],
    otherBb: { cpuPercent: 0, rssBytes: 0, processCount: 0, processes: [] },
    others: [
      {
        pid: 9,
        name: "Xorg",
        cpuPercent: 3,
        rssBytes: 500_000_000,
        startToken: "x",
      },
    ],
  };
}

function renderPanel(machines: MachineView[]) {
  return renderSlot(
    { component: ResourcesPanel },
    { subPath: "" },
    {
      experimental_rpcContract: processesContract,
      rpc: {
        "resources.machines": () => ({ machines, toasts: true }),
        "resources.machine": () => usage(),
        "processes.stop": () => ({ outcome: "stopped" as const }),
      },
    },
  );
}

describe("Resources page", () => {
  it("shows CPU, memory and disk of each machine and ranks its threads", async () => {
    renderPanel([
      machine(),
      machine({
        hostId: "host_2",
        name: "build-box",
        online: false,
        memory: null,
        disks: [],
      }),
    ]);
    expect(await screen.findByText("laptop")).not.toBeNull();
    expect(screen.getByRole("meter", { name: "CPU" })).not.toBeNull();
    expect(screen.getByRole("meter", { name: "Memory" })).not.toBeNull();
    expect(screen.getByRole("meter", { name: "Disk /home" })).not.toBeNull();
    expect(await screen.findByText("Heavy thread")).not.toBeNull();
    expect(screen.getByText("Offline")).not.toBeNull();
    expect(screen.getByText("Xorg")).not.toBeNull();
  });

  it("offers Stop for a command, never for the agent, and asks twice", async () => {
    const slot = renderPanel([machine()]);
    fireEvent.click(await screen.findByRole("button", { name: /^\+/ }));
    expect(screen.getByText("claude")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Stop claude" })).toBeNull();
    const stop = await screen.findByRole("button", { name: "Stop python3" });
    fireEvent.click(stop);
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "processes.stop"),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm stop of python3" }),
    );
    await expect
      .poll(() =>
        slot.inspection.rpcCalls.find(
          (call) => call.method === "processes.stop",
        ),
      )
      .toMatchObject({
        input: { threadId: "thr_a", rootPid: 140, startToken: "tok-140" },
      });
  });

  it("drops the confirmation after a few seconds", async () => {
    renderPanel([machine()]);
    fireEvent.click(await screen.findByRole("button", { name: /^\+/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop python3" }),
    );
    expect(screen.getByRole("button", { name: /Confirm stop/ })).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    expect(screen.queryByRole("button", { name: /Confirm stop/ })).toBeNull();
  }, 10_000);
});

describe("Resources badge", () => {
  it("shows the worst machine as a short badge, or nothing when all are fine", () => {
    expect(badgeFor([machine()])).toBeNull();
    expect(
      badgeFor([
        machine({
          status: "warning",
          reasons: ["Memory 92% used"],
          memory: { ...machine().memory!, percent: 92, status: "warning" },
        }),
        machine({
          hostId: "host_2",
          name: "box",
          status: "critical",
          reasons: ["Disk /home 3% free"],
          disks: [
            {
              path: "/home",
              totalBytes: 100,
              freeBytes: 3,
              freePercent: 3,
              status: "critical",
            },
          ],
        }),
      ]),
    ).toEqual({
      text: "Disk 3%",
      tone: "critical",
      label: "box: Disk /home 3% free",
    });
    expect(
      badgeFor([machine({ status: "warning", reasons: ["CPU saturated"] })])
        ?.text,
    ).toBe("CPU");
  });
});

describe("Thread Info Processes section", () => {
  function renderSection(result: unknown) {
    return renderSlot(
      { component: ThreadProcessesSection },
      { threadId: "thr_a", projectId: "proj_1", environment: { id: "env_1" } },
      {
        experimental_rpcContract: processesContract,
        rpc: { "resources.thread": () => result as never },
      },
    );
  }

  it("shows the totals and the processes of the thread", async () => {
    renderSection({
      status: "ok",
      reason: null,
      hostId: "host_1",
      hostName: "laptop",
      usage: usage().threads[0],
    });
    expect(await screen.findByText(/101% CPU/)).not.toBeNull();
    expect(screen.getByText("python3")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Stop claude" })).toBeNull();
  });

  it("explains why a machine has no process data", async () => {
    renderSection({
      status: "unsupported",
      reason: "bb could not read process environments on this Windows machine",
      hostId: "host_1",
      hostName: "pc",
      usage: null,
    });
    expect(await screen.findByText(/Windows machine/)).not.toBeNull();
  });

  it("draws nothing for a thread without an environment", () => {
    const slot = renderSection({
      status: "no-environment",
      reason: "none",
      hostId: null,
      hostName: null,
      usage: null,
    });
    expect(slot.container.textContent).toBe("");
  });
});

describe("Resources toasts", () => {
  const sequence = (status: "ok" | "warning" | "critical") =>
    machine({
      status,
      reasons: status === "ok" ? [] : ["Memory 92% used"],
    });

  it("does not toast for a machine that is already low when the app loads, then toasts once for each crossing", () => {
    const memory = newToastMemory();
    expect(crossings(memory, [sequence("warning")])).toEqual([]);
    expect(crossings(memory, [sequence("warning")])).toEqual([]);
    expect(crossings(memory, [sequence("ok")])).toEqual([]);
    expect(crossings(memory, [sequence("warning")])).toMatchObject([
      { hostId: "host_1", status: "warning" },
    ]);
    expect(crossings(memory, [sequence("warning")])).toEqual([]);
    expect(crossings(memory, [sequence("critical")])).toMatchObject([
      { status: "critical" },
    ]);
    expect(crossings(memory, [sequence("critical")])).toEqual([]);
    expect(crossings(memory, [sequence("warning")])).toEqual([]);
  });

  it("ignores a machine that is offline", () => {
    const memory = newToastMemory();
    crossings(memory, [machine({ online: false })]);
    expect(
      crossings(memory, [machine({ online: false, status: "critical" })]),
    ).toEqual([]);
  });

  it("draws no badge when the notices are turned off", async () => {
    function Probe() {
      return (
        <span data-testid="badge">{JSON.stringify(useResourcesBadge())}</span>
      );
    }
    const render = (toasts: boolean) =>
      renderSlot(
        { component: Probe },
        {},
        {
          experimental_rpcContract: processesContract,
          rpc: {
            "resources.machines": () => ({
              machines: [sequence("critical")],
              toasts,
            }),
          },
        },
      );
    render(true);
    await expect
      .poll(() => screen.getByTestId("badge").textContent)
      .toContain('"tone":"critical"');
    cleanup();
    render(false);
    await expect
      .poll(() => screen.getByTestId("badge").textContent)
      .toBe("null");
  });
});
