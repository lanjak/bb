import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createManagedCohortController } from "../src/managed-cohort-controller.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), delayed: false, resume: undefined as (() => void) | undefined }));
vi.mock("../src/logged-process.js", () => ({ spawnLoggedProcess: native.spawn }));
vi.mock("@bb/config/file-lock", async () => {
  const owner = await import("../../config/src/managed-root-admission.js");
  return {
    ...owner,
    internal_DO_NOT_USE_beginManagedRootEffect(effect: string) {
      const original = owner.internal_DO_NOT_USE_beginManagedRootEffect(effect);
      return {
        ...original,
        runOriginal<T>(body: () => Promise<T>): Promise<T> {
          if (!native.delayed) return original.runOriginal(body);
          return original.runOriginal(async () => {
            await new Promise<void>((resolve) => { native.resume = resolve; });
            return body();
          });
        },
      };
    },
  };
});

class OriginalChild extends EventEmitter {
  connected = true;
  sent: object[] = [];
  delayed = false;
  callbacks: ((error: Error | null) => void)[] = [];
  kill = vi.fn(() => true);
  send(message: object, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    if (this.delayed) this.callbacks.push(callback);
    else callback(null);
    return true;
  }
}

describe("managed cohort original-channel control, not native custody", () => {
  it("retains a throwing kill outcome and still joins original close", async () => {
    native.spawn.mockClear();
    const controller = createManagedCohortController(["server"], undefined, {
      serverEntry: "/fixed/server.js", daemonEntry: "/fixed/daemon.js", logDir: "/fixed/logs", env: {},
    });
    const child = new OriginalChild();
    child.kill.mockImplementation(() => { throw undefined; });
    native.spawn.mockReturnValue(child);
    await controller.spawnFixedOriginal("server");
    let finished = false;
    const draining = controller.drain().then((result) => { finished = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalled();
    expect(finished).toBe(false);
    child.emit("close");
    const result = await draining;
    expect(result.failures).toContain(undefined);
    expect(result.status).toBe("PINNED");
  });

  it("joins the queued spawn attempt and denies its body after drain starts", async () => {
    native.spawn.mockClear();
    native.delayed = true;
    const controller = createManagedCohortController(["server"], undefined, {
      serverEntry: "/fixed/server.js", daemonEntry: "/fixed/daemon.js", logDir: "/fixed/logs", env: {},
    });
    try {
      const spawning = controller.spawnFixedOriginal("server");
      const rejection = expect(spawning).rejects.toThrow();
      let finished = false;
      const draining = controller.drain().then(() => { finished = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(native.spawn).not.toHaveBeenCalled();
      expect(native.resume).toBeTypeOf("function");
      native.resume?.();
      await rejection;
      await draining;
      expect(native.spawn).not.toHaveBeenCalled();
    } finally {
      native.delayed = false;
      native.resume = undefined;
    }
  });

  it("refuses missing and duplicate roles before simulated spawn", async () => {
    native.spawn.mockClear();
    const config = { serverEntry: "/fixed/server.js", daemonEntry: "/fixed/daemon.js", logDir: "/fixed/logs", env: {} };
    const controller = createManagedCohortController(["server"], undefined, config);
    await expect(controller.spawnFixedOriginal("host-daemon")).rejects.toThrow();
    expect(native.spawn).not.toHaveBeenCalled();
    const child = new OriginalChild();
    native.spawn.mockReturnValue(child);
    await controller.spawnFixedOriginal("server");
    await expect(controller.spawnFixedOriginal("server")).rejects.toThrow();
    expect(native.spawn).toHaveBeenCalledTimes(1);
    const draining = controller.drain();
    child.emit("close");
    await draining;
  });

  it("joins original close despite error and ignores caller configuration mutation", async () => {
    native.spawn.mockClear();
    const config = { serverEntry: "/fixed/server.js", daemonEntry: "/fixed/daemon.js", logDir: "/fixed/logs", env: { NODE_OPTIONS: "--require evil", BB_DATA_DIR: "/fixed/data" } };
    const controller = createManagedCohortController(["server"], undefined, config);
    config.serverEntry = "/changed.js";
    config.env.BB_DATA_DIR = "/changed";
    const child = new OriginalChild();
    native.spawn.mockReturnValue(child);
    await controller.spawnFixedOriginal("server");
    expect(native.spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: ["/fixed/server.js", "--bb-managed-bootstrap"],
      env: { BB_DATA_DIR: "/fixed/data" },
      ipc: true,
    }));
    child.emit("error", undefined);
    let finished = false;
    const draining = controller.drain().then((result) => { finished = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    child.emit("close");
    const result = await draining;
    expect(result.status).toBe("PINNED");
    expect(result.failures).toContain(undefined);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not bind one original child to different required roles", () => {
    const controller = createManagedCohortController(["server", "host-daemon"]);
    const child = new OriginalChild();
    controller.attachOriginal("server", child);
    expect(() => controller.attachOriginal("host-daemon", child)).toThrow();
    expect(controller.snapshot().attached).toBe(1);
  });

  it("pins delayed send failure even after reentrant registered traffic", () => {
    const controller = createManagedCohortController(["server"]);
    const child = new OriginalChild();
    child.delayed = true;
    controller.attachOriginal("server", child);
    child.emit("message", { channel: "bb-managed-process", type: "ready", role: "server" });
    child.emit("message", { channel: "bb-managed-process", type: "registered", role: "server" });
    for (const callback of [...child.callbacks]) callback(new Error("original send failed"));
    expect(controller.snapshot()).toMatchObject({ pinned: true, cohort: "NOT_ESTABLISHED", attached: 1 });
  });

  it("does not revive after disconnect and a late successful send", () => {
    const controller = createManagedCohortController(["server"]);
    const child = new OriginalChild();
    child.delayed = true;
    controller.attachOriginal("server", child);
    child.emit("message", { channel: "bb-managed-process", type: "ready", role: "server" });
    child.emit("disconnect");
    for (const callback of [...child.callbacks]) callback(null);
    child.emit("message", { channel: "bb-managed-process", type: "registered", role: "server" });
    expect(controller.snapshot()).toMatchObject({ pinned: true, attached: 1 });
  });

  it("retains required original membership after disconnect and close", () => {
    const controller = createManagedCohortController(["server", "host-daemon"]);
    const child = new OriginalChild();
    controller.attachOriginal("server", child);
    child.emit("message", { channel: "bb-managed-process", type: "ready", role: "server" });
    expect(child.sent).toEqual([{ channel: "bb-managed-process", type: "continue", role: "server" }]);
    child.emit("message", { channel: "bb-managed-process", type: "registered", role: "server" });
    child.emit("disconnect");
    child.emit("close", 0, null);
    expect(controller.snapshot()).toMatchObject({
      cohort: "NOT_ESTABLISHED",
      required: 2,
      attached: 1,
      pinned: true,
      predecessor: "UNKNOWN",
    });
    expect(() => controller.attachOriginal("server", new OriginalChild())).toThrow();
  });

  it("does not treat exit or a forged predecessor as original drain", () => {
    const controller = createManagedCohortController(["server"], { drain: Promise.resolve() });
    const child = new OriginalChild();
    controller.attachOriginal("server", child);
    child.emit("exit", 0, null);
    expect(controller.snapshot()).toMatchObject({ predecessor: "UNKNOWN", closed: 0 });
    child.emit("close", 0, null);
    expect(controller.snapshot()).toMatchObject({ cohort: "NOT_ESTABLISHED", closed: 1 });
  });

  it("pins duplicate ready without releasing bootstrap twice", () => {
    const controller = createManagedCohortController(["server"]);
    const child = new OriginalChild();
    controller.attachOriginal("server", child);
    const ready = { channel: "bb-managed-process", type: "ready", role: "server" };
    child.emit("message", ready);
    child.emit("message", ready);
    expect(child.sent.filter((message) => "type" in message && message.type === "continue")).toHaveLength(1);
    expect(controller.snapshot().pinned).toBe(true);
  });
});
