import type { ManagedParentToProcessMessage, ManagedProcessRole } from "@bb/config/managed-process-registration";
import { internal_DO_NOT_USE_beginManagedRootEffect, type ManagedRootEffect } from "@bb/config/file-lock";
import { spawnLoggedProcess } from "./logged-process.js";

interface OriginalChild {
  readonly connected: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  send?: ((message: ManagedParentToProcessMessage, callback: (error: Error | null) => void) => boolean) | undefined;
}

interface OriginalRecord {
  child: OriginalChild;
  phase: "waiting" | "continuing" | "registered" | "revoked";
  closed: boolean;
}

const controllers = new WeakMap<object, { drain(): Promise<{ status: "PINNED"; failures: readonly unknown[] }> }>();

export function createManagedCohortController(
  roles: readonly ManagedProcessRole[],
  predecessor: object | undefined = undefined,
  launch: { serverEntry: string; daemonEntry: string; logDir: string; env: NodeJS.ProcessEnv } | undefined = undefined,
) {
  const fixedLaunch = launch === undefined ? undefined : Object.freeze({
    serverEntry: launch.serverEntry,
    daemonEntry: launch.daemonEntry,
    logDir: launch.logDir,
    env: Object.freeze({ ...launch.env }),
  });
  const required = new Set(roles);
  if (required.size === 0 || required.size !== roles.length) throw new Error("Managed cohort requires distinct fixed roles.");
  const records = new Map<ManagedProcessRole, OriginalRecord>();
  const spawning = new Set<ManagedProcessRole>();
  const effects = new Set<ManagedRootEffect>();
  const cleanups = new Set<() => Promise<void>>();
  const failures: unknown[] = [];
  const children = new WeakSet<OriginalChild>();
  const originalPredecessor = predecessor !== undefined && controllers.has(predecessor) ? predecessor : undefined;
  let pinned = false;
  const revoke = (): void => {
    pinned = true;
    for (const [role, record] of records) {
      if (record.phase === "revoked") continue;
      record.phase = "revoked";
      try {
        record.child.send?.({ channel: "bb-managed-process", type: "revoke", role }, (error) => {
          if (error !== null) failures.push(error);
        });
      } catch (reason) {
        failures.push(reason);
      }
    }
  };
  const controller = Object.freeze({
    async spawnFixedOriginal(
      role: "server" | "host-daemon",
    ) {
      if (fixedLaunch === undefined || pinned || !required.has(role) || records.has(role) || spawning.has(role)) throw new Error("Managed cohort cannot spawn an unreserved required role.");
      spawning.add(role);
      const effect = controller.beginOriginalEffect(`fixed ${role} bootstrap spawn`);
      let child: ReturnType<typeof spawnLoggedProcess> | undefined;
      let closed: Promise<void> | undefined;
      let settleAttempt: () => void = () => undefined;
      const attemptSettled = new Promise<void>((resolve) => { settleAttempt = resolve; });
      const cleanup = effect.reserveOriginalCleanup(async () => {
        await attemptSettled;
        if (child === undefined || closed === undefined) return;
        child.kill("SIGTERM");
        await closed;
        });
      } finally {
        settleAttempt();
      }
      cleanups.add(cleanup);
      const sanitizedEnv: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "BB_DATA_DIR", "BB_SERVER_URL", "BB_HOST_ID", "BB_HOST_KEY"]) {
        if (fixedLaunch.env[key] !== undefined) sanitizedEnv[key] = fixedLaunch.env[key];
      }
      try {
        return await effect.runOriginal(async () => {
        if (pinned) throw new Error("Managed cohort was revoked before its spawn attempt.");
        effect.assertOriginalAtDequeue();
        child = spawnLoggedProcess({
          command: process.execPath,
          args: [role === "server" ? fixedLaunch.serverEntry : fixedLaunch.daemonEntry, "--bb-managed-bootstrap"],
          env: sanitizedEnv,
          ipc: true,
          logDir: fixedLaunch.logDir,
          logName: role,
        });
        const originalChild = child;
        closed = new Promise<void>((resolve) => {
          originalChild.once("close", () => resolve());
        });
        originalChild.on("error", (reason: unknown) => { failures.push(reason); revoke(); });
        controller.attachOriginal(role, originalChild);
        return originalChild;
      });
    },
    beginOriginalEffect(effect: string): ManagedRootEffect {
      if (pinned) throw new Error("Managed cohort no longer accepts effects.");
      const original = internal_DO_NOT_USE_beginManagedRootEffect(effect);
      effects.add(original);
      return original;
    },
    attachOriginal(role: ManagedProcessRole, child: OriginalChild): void {
      if (pinned || !required.has(role) || records.has(role) || children.has(child) || child.send === undefined) throw new Error("Managed cohort cannot replace an original required child.");
      children.add(child);
      const record: OriginalRecord = { child, phase: "waiting", closed: false };
      records.set(role, record);
      child.on("disconnect", revoke);
      child.on("close", () => {
        record.closed = true;
        revoke();
      });
      child.on("message", (raw: unknown) => {
        if (typeof raw !== "object" || raw === null || !("channel" in raw) || raw.channel !== "bb-managed-process") return;
        if (pinned || !child.connected || !("role" in raw) || raw.role !== role || !("type" in raw)) {
          revoke();
          return;
        }
        if (raw.type === "ready" && record.phase === "waiting") {
          record.phase = "continuing";
          try {
            child.send?.({ channel: "bb-managed-process", type: "continue", role }, (error) => {
              if (error !== null || !child.connected) revoke();
            });
          } catch {
            revoke();
          }
        } else if (raw.type === "registered" && record.phase === "continuing") {
          record.phase = "registered";
        } else {
          revoke();
        }
      });
      if (!child.connected) revoke();
    },
    revoke,
    async drain(): Promise<{ status: "PINNED"; failures: readonly unknown[] }> {
      revoke();
      await Promise.all([...cleanups].map(async (cleanup) => {
        try { await cleanup(); } catch (reason) { failures.push(reason); }
      }));
      const retainedFailures = [...failures];
      for (const original of effects) retainedFailures.push(...original.complete().failures);
      if (originalPredecessor !== undefined) {
        const original = controllers.get(originalPredecessor);
        if (original !== undefined) retainedFailures.push(...(await original.drain()).failures);
      }
      return { status: "PINNED", failures: retainedFailures };
    },
    snapshot() {
      return {
        cohort: "NOT_ESTABLISHED" as const,
        predecessor: originalPredecessor !== undefined ? "ORIGINAL_RETAINED" as const : "UNKNOWN" as const,
        required: required.size,
        attached: records.size,
        closed: [...records.values()].filter((record) => record.closed).length,
        pinned,
      };
    },
  });
  controllers.set(controller, controller);
  return controller;
}
