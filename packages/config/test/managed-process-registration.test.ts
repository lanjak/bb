import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { internal_DO_NOT_USE_registerManagedProcess } from "../src/managed-process-registration.js";
import {
  internal_DO_NOT_USE_assertManagedRootAdmission,
  internal_DO_NOT_USE_beginManagedRootEffect,
} from "@bb/config/internal-managed-root-admission";

class ParentPort extends EventEmitter {
  connected = true;
  delayed = false;
  callbacks: ((error: Error | null) => void)[] = [];
  sent: object[] = [];
  send(message: object, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    if (this.delayed) this.callbacks.push(callback);
    else callback(null);
    return true;
  }
}

describe("managed process bootstrap control, not native custody", () => {
  it("shares registration admission and revocation state with the canonical owner", async () => {
    expect(() => internal_DO_NOT_USE_assertManagedRootAdmission("before process registration")).not.toThrow();
    const originalEffect = internal_DO_NOT_USE_beginManagedRootEffect("before process registration");
    const port = new ParentPort();
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    expect(() => internal_DO_NOT_USE_assertManagedRootAdmission("after process registration")).toThrow();
    expect(() => originalEffect.assertOriginalAtDequeue()).toThrow();
    expect(originalEffect.complete().status).toBe("PINNED");
    port.emit("message", { channel: "bb-managed-process", type: "continue", role: "server" });
    const registration = await pending;
    registration.revoke();
    expect(() => registration.assertBootstrapActive()).toThrow();
    expect(() => internal_DO_NOT_USE_assertManagedRootAdmission("after process revocation")).toThrow();
  });

  it("rejects delayed acknowledgement after revocation", async () => {
    const port = new ParentPort();
    port.delayed = true;
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    port.emit("message", { channel: "bb-managed-process", type: "continue", role: "server" });
    port.emit("message", { channel: "bb-managed-process", type: "revoke", role: "server" });
    for (const callback of port.callbacks) callback(null);
    await expect(pending).rejects.toThrow();
  });

  it("rechecks revocation between resolution and the await continuation", async () => {
    const port = new ParentPort();
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    port.emit("message", { channel: "bb-managed-process", type: "continue", role: "server" });
    port.emit("disconnect");
    const registration = await pending;
    expect(() => registration.assertBootstrapActive()).toThrow();
  });

  it("revokes on duplicate continuation", async () => {
    const port = new ParentPort();
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    const message = { channel: "bb-managed-process", type: "continue", role: "server" };
    port.emit("message", message);
    port.emit("message", message);
    const registration = await pending;
    expect(() => registration.assertBootstrapActive()).toThrow();
    expect(port.sent).toHaveLength(2);
  });

  it("rejects original send callback errors", async () => {
    const port = new ParentPort();
    port.delayed = true;
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    for (const callback of port.callbacks) callback(new Error("original send failed"));
    await expect(pending).rejects.toThrow();
  });

  it("does not continue without the original channel", async () => {
    const port = new ParentPort();
    port.connected = false;
    await expect(internal_DO_NOT_USE_registerManagedProcess("server", port)).rejects.toThrow();
    expect(port.sent).toEqual([]);
  });

  it("holds continuation until a directional response and revokes synchronously", async () => {
    const port = new ParentPort();
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    let continued = false;
    void pending.then(() => { continued = true; });
    await Promise.resolve();
    expect(continued).toBe(false);
    expect(port.sent).toEqual([{ channel: "bb-managed-process", type: "ready", role: "server" }]);
    port.emit("message", { channel: "bb-managed-process", type: "continue", role: "server" });
    const registration = await pending;
    expect(registration.cohort).toBe("NOT_ESTABLISHED");
    expect(() => registration.assertBootstrapActive()).not.toThrow();
    port.emit("message", { channel: "bb-managed-process", type: "revoke", role: "server" });
    expect(() => registration.assertBootstrapActive()).toThrow();
  });

  it.each([
    { channel: "bb-managed-process", type: "registered", role: "server" },
    { channel: "bb-managed-process", type: "continue", role: "host-daemon" },
  ])("rejects wrong direction or role before continuation: %j", async (message) => {
    const port = new ParentPort();
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    port.emit("message", message);
    await expect(pending).rejects.toThrow();
  });

  it("cannot repeat registration on the same original port", async () => {
    const port = new ParentPort();
    const pending = internal_DO_NOT_USE_registerManagedProcess("server", port);
    const duplicate = internal_DO_NOT_USE_registerManagedProcess("server", port);
    await expect(duplicate).rejects.toThrow();
    port.emit("disconnect");
    await expect(pending).rejects.toThrow();
  });
});
