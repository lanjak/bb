import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createManagedCohortController } from "../src/managed-cohort-controller.js";

vi.mock("../src/logged-process.js", () => ({
  spawnLoggedProcess: () => { throw new Error("Native spawn forbidden in controller control tests."); },
}));

class OriginalChild extends EventEmitter {
  connected = true;
  sent: object[] = [];
  delayed = false;
  callbacks: ((error: Error | null) => void)[] = [];
  send(message: object, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    if (this.delayed) this.callbacks.push(callback);
    else callback(null);
    return true;
  }
}

describe("managed cohort original-channel control, not native custody", () => {
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
