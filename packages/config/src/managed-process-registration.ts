import { internal_DO_NOT_USE_enrollManagedRoot } from "./managed-root-admission.js";

export type ManagedProcessRole = "server" | "host-daemon" | "bootstrap-cli";

export type ManagedProcessToParentMessage = {
  channel: "bb-managed-process";
  type: "ready" | "registered";
  role: ManagedProcessRole;
};

export type ManagedParentToProcessMessage = {
  channel: "bb-managed-process";
  type: "continue" | "revoke";
  role: ManagedProcessRole;
};

export interface ManagedProcessPort {
  readonly connected: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  send?: ((message: ManagedProcessToParentMessage, callback: (error: Error | null) => void) => boolean) | undefined;
}

export interface ManagedProcessRegistration {
  readonly cohort: "NOT_ESTABLISHED";
  assertBootstrapActive(): void;
  revoke(): void;
}

const originals = new WeakSet<ManagedProcessPort>();

export function internal_DO_NOT_USE_registerManagedProcess(
  role: ManagedProcessRole,
  port: ManagedProcessPort,
): Promise<ManagedProcessRegistration> {
  if (!port.connected || port.send === undefined || originals.has(port)) {
    return Promise.reject(new Error("Managed bootstrap requires its unused original parent channel."));
  }
  originals.add(port);
  const root = internal_DO_NOT_USE_enrollManagedRoot(port);
  let phase: "waiting" | "released" | "revoked" = "waiting";
  return new Promise((resolve, reject) => {
    const revoke = (): void => {
      phase = "revoked";
      try {
        root.revoke();
      } finally {
        reject(new Error("Managed bootstrap association is unavailable."));
      }
    };
    const registration: ManagedProcessRegistration = Object.freeze({
      cohort: "NOT_ESTABLISHED",
      assertBootstrapActive() {
        if (phase !== "released") throw new Error("Managed bootstrap is revoked.");
      },
      revoke,
    });
    const send = (message: ManagedProcessToParentMessage, done: () => void): void => {
      try {
        port.send?.(message, (error) => {
          if (error !== null || !port.connected || phase === "revoked") revoke();
          else done();
        });
      } catch {
        revoke();
      }
    };
    port.on("disconnect", revoke);
    port.on("message", (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || !("channel" in raw) || raw.channel !== "bb-managed-process") return;
      if (!("type" in raw) || !("role" in raw) || raw.role !== role) {
        revoke();
        return;
      }
      if (raw.type === "revoke") {
        revoke();
        return;
      }
      if (raw.type !== "continue" || phase !== "waiting" || !port.connected) {
        revoke();
        return;
      }
      phase = "released";
      send({ channel: "bb-managed-process", type: "registered", role }, () => {
        if (phase === "released") resolve(registration);
      });
    });
    send({ channel: "bb-managed-process", type: "ready", role }, () => undefined);
  });
}
