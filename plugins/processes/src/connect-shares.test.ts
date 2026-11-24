import { describe, expect, it } from "vitest";
import {
  OFF_REASON,
  SHARE_GONE_MS,
  createConnectShares,
  type ConnectShare,
  type CreatedShare,
} from "./connect-shares.js";

function setup(
  options: {
    status?: { enabled: boolean; paired: boolean; state: string } | "throws";
    existing?: ConnectShare[];
    exposeFails?: boolean;
    unexposeFails?: boolean;
  } = {},
) {
  let stored: unknown = null;
  let now = 1_000_000;
  const exposed: Array<{ hostId: string; port: number }> = [];
  const unexposed: Array<{ hostId: string; port: number }> = [];
  const warnings: string[] = [];
  const shares = createConnectShares({
    loadCreated: async () => stored,
    saveCreated: async (next) => {
      stored = next;
    },
    status: async () => {
      if (options.status === "throws") throw new Error("plugin missing");
      return (
        options.status ?? { enabled: true, paired: true, state: "connected" }
      );
    },
    listShares: async () => options.existing ?? [],
    expose: async (args) => {
      if (options.exposeFails) throw new Error("no machine credential");
      exposed.push(args);
      return { ...args, url: `https://${args.hostId}--${args.port}.example/` };
    },
    unexpose: async (args) => {
      if (options.unexposeFails) throw new Error("gone");
      unexposed.push(args);
    },
    now: () => now,
    warn: (message) => warnings.push(message),
  });
  return {
    shares,
    exposed,
    unexposed,
    warnings,
    stored: () => stored as CreatedShare[] | null,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const request = { threadId: "thr_a", hostId: "host_a", port: 5173 };

describe("opening a port through bb Connect", () => {
  it("creates nothing when bb Connect is off, not paired, not connected or missing", async () => {
    for (const status of [
      { enabled: false, paired: true, state: "connected" },
      { enabled: true, paired: false, state: "connected" },
      { enabled: true, paired: true, state: "reconnecting" },
      "throws" as const,
    ]) {
      const test = setup({ status });
      await expect(test.shares.open(request)).resolves.toEqual({
        status: "connect-off",
        reason: OFF_REASON,
      });
      expect(test.exposed).toEqual([]);
      expect(test.stored()).toBeNull();
    }
  });

  it("creates a share and records it, so only the plugin removes it", async () => {
    const test = setup();
    await expect(test.shares.open(request)).resolves.toEqual({
      status: "ok",
      url: "https://host_a--5173.example/",
    });
    expect(test.exposed).toEqual([{ hostId: "host_a", port: 5173 }]);
    expect(test.stored()).toEqual([{ ...request, lastSeenAt: 1_000_000 }]);
  });

  it("reuses a share that already exists and never records it as its own", async () => {
    const test = setup({
      existing: [
        { hostId: "host_a", port: 5173, url: "https://by-the-user.example/" },
      ],
    });
    await expect(test.shares.open(request)).resolves.toEqual({
      status: "ok",
      url: "https://by-the-user.example/",
    });
    expect(test.exposed).toEqual([]);
    expect(test.stored()).toBeNull();
    await test.shares.sweep({
      threadId: "thr_a",
      listening: [],
      archived: true,
    });
    expect(test.unexposed).toEqual([]);
  });

  it("reports a share it could not create", async () => {
    const test = setup({ exposeFails: true });
    await expect(test.shares.open(request)).resolves.toEqual({
      status: "failed",
      reason: "bb Connect could not share the port: no machine credential",
    });
    expect(test.stored()).toBeNull();
  });
});

describe("removing the shares the plugin created", () => {
  it("keeps a share while its port listens, and removes it 60 seconds after the port is gone", async () => {
    const test = setup();
    await test.shares.open(request);
    test.advance(SHARE_GONE_MS - 1);
    await test.shares.sweep({ threadId: "thr_a", listening: [] });
    expect(test.unexposed).toEqual([]);
    await test.shares.sweep({
      threadId: "thr_a",
      listening: [{ hostId: "host_a", port: 5173 }],
    });
    test.advance(SHARE_GONE_MS - 1);
    await test.shares.sweep({ threadId: "thr_a", listening: [] });
    expect(test.unexposed).toEqual([]);
    test.advance(2);
    await test.shares.sweep({ threadId: "thr_a", listening: [] });
    expect(test.unexposed).toEqual([{ hostId: "host_a", port: 5173 }]);
    expect(test.stored()).toEqual([]);
  });

  it("removes its shares of a thread when the thread is archived, and leaves other threads alone", async () => {
    const test = setup();
    await test.shares.open(request);
    await test.shares.open({ ...request, threadId: "thr_b", port: 3000 });
    await test.shares.sweep({
      threadId: "thr_a",
      listening: [],
      archived: true,
    });
    expect(test.unexposed).toEqual([{ hostId: "host_a", port: 5173 }]);
    expect(test.stored()).toMatchObject([{ threadId: "thr_b", port: 3000 }]);
  });

  it("keeps the record when a share cannot be removed, and tries again later", async () => {
    const test = setup({ unexposeFails: true });
    await test.shares.open(request);
    test.advance(SHARE_GONE_MS);
    await test.shares.sweep({ threadId: "thr_a", listening: [] });
    expect(test.stored()).toHaveLength(1);
    expect(test.warnings[0]).toContain("host_a:5173");
  });

  it("ignores a stored value it does not understand", async () => {
    const test = setup();
    await expect(test.shares.created()).resolves.toEqual([]);
  });
});

describe("concurrent requests", () => {
  function slowStore() {
    let stored: CreatedShare[] = [];
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const unexposed: number[] = [];
    let now = 0;
    const shares = createConnectShares({
      loadCreated: async () => {
        const snapshot = stored;
        await pause();
        return snapshot;
      },
      saveCreated: async (next) => {
        await pause();
        stored = next;
      },
      status: async () => ({
        enabled: true,
        paired: true,
        state: "connected",
      }),
      listShares: async () => [],
      expose: async (args) => ({ ...args, url: `https://${args.port}/` }),
      unexpose: async (args) => {
        unexposed.push(args.port);
      },
      now: () => now,
      warn: () => undefined,
    });
    return {
      shares,
      unexposed,
      ports: () => stored.map((share) => share.port).sort(),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("records both shares when two are opened at once", async () => {
    const test = slowStore();
    await Promise.all([
      test.shares.open(request),
      test.shares.open({ ...request, port: 3000 }),
    ]);
    expect(test.ports()).toEqual([3000, 5173]);
  });

  it("keeps a share opened while an older one is being removed", async () => {
    const test = slowStore();
    await test.shares.open(request);
    test.advance(SHARE_GONE_MS);
    await Promise.all([
      test.shares.sweep({ threadId: "thr_a", listening: [] }),
      test.shares.open({ ...request, port: 3000 }),
    ]);
    expect(test.unexposed).toEqual([5173]);
    expect(test.ports()).toEqual([3000]);
  });

  it("sweeps every thread with a share, and leaves one whose ports are unknown", async () => {
    const test = slowStore();
    await test.shares.open(request);
    await test.shares.open({ ...request, threadId: "thr_b", port: 3000 });
    test.advance(SHARE_GONE_MS);
    const asked: string[] = [];
    await test.shares.sweepAll(async (threadId) => {
      asked.push(threadId);
      return threadId === "thr_a" ? [] : null;
    });
    expect(asked.sort()).toEqual(["thr_a", "thr_b"]);
    expect(test.unexposed).toEqual([5173]);
    expect(test.ports()).toEqual([3000]);
  });
});
