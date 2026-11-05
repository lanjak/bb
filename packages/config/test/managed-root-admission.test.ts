import { expect, it, vi } from "vitest";
import {
  internal_DO_NOT_USE_beginManagedRootEffect,
  internal_DO_NOT_USE_enrollManagedRoot,
  ManagedRootAdmissionUnavailableError,
} from "../src/managed-root-admission.js";

vi.resetModules();

it("closes original body admission on completion and enrollment while retaining only reserved cleanup", async () => {
  const finished = internal_DO_NOT_USE_beginManagedRootEffect("ordinary");
  expect(await finished.runOriginal(() => Promise.resolve(17))).toBe(17);
  expect(finished.complete().status).toBe("RELEASED");
  let calls = 0;
  expect(() => finished.runOriginal(() => { calls += 1; return Promise.resolve(); })).toThrow(ManagedRootAdmissionUnavailableError);
  expect(calls).toBe(0);

  const reentrant = internal_DO_NOT_USE_beginManagedRootEffect("reentrant completion");
  let finishReentrant!: () => void;
  const reentrantPromise = new Promise<void>((resolve) => { finishReentrant = resolve; });
  const retained = reentrant.runOriginal(() => {
    expect(reentrant.complete().status).toBe("PINNED");
    return reentrantPromise;
  });
  expect(retained).toBe(reentrantPromise);
  finishReentrant();
  await retained;
  expect(reentrant.complete().status).toBe("PINNED");
  const recursive = internal_DO_NOT_USE_beginManagedRootEffect("recursive cleanup");
  let recursiveCalls = 0;
  const recursiveCleanup: () => Promise<void> = recursive.reserveOriginalCleanup(() => {
    recursiveCalls += 1;
    expect(() => recursiveCleanup()).toThrow(ManagedRootAdmissionUnavailableError);
    return Promise.resolve();
  });
  await recursiveCleanup();
  expect(recursiveCalls).toBe(1);
  expect(recursive.complete().status).toBe("PINNED");

  const syncFailure = internal_DO_NOT_USE_beginManagedRootEffect("synchronous original failure");
  await expect(syncFailure.runOriginal(() => { throw undefined; })).rejects.toBeUndefined();
  expect(syncFailure.complete()).toEqual({ status: "PINNED", failures: [undefined] });
  const syncCleanup = internal_DO_NOT_USE_beginManagedRootEffect("synchronous cleanup failure");
  const failCleanup = syncCleanup.reserveOriginalCleanup(() => { throw undefined; });
  const failedCleanup = failCleanup();
  expect(failCleanup()).toBe(failedCleanup);
  await expect(failedCleanup).rejects.toBeUndefined();
  expect(syncCleanup.complete()).toEqual({ status: "PINNED", failures: [undefined] });

  const pending = internal_DO_NOT_USE_beginManagedRootEffect("pending cleanup");
  let cleanupCalls = 0;
  const cleanup = pending.reserveOriginalCleanup(() => { cleanupCalls += 1; return Promise.reject(undefined); });
  expect(pending.complete().status).toBe("PINNED");
  expect(() => pending.runOriginal(() => { calls += 1; return Promise.resolve(); })).toThrow(ManagedRootAdmissionUnavailableError);
  expect(() => pending.reserveOriginalCleanup(() => Promise.resolve())).toThrow(ManagedRootAdmissionUnavailableError);
  const originalCleanup = cleanup();
  expect(cleanup()).toBe(originalCleanup);
  await expect(originalCleanup).rejects.toBeUndefined();
  expect(cleanupCalls).toBe(1);
  expect(pending.complete()).toEqual({ status: "PINNED", failures: [undefined] });

  const queued = internal_DO_NOT_USE_beginManagedRootEffect("queued write");
  const reserved = queued.reserveOriginalCleanup(() => { cleanupCalls += 1; return Promise.resolve(); });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const original = queued.runOriginal(async () => {
    await barrier;
    try {
      return await queued.runOriginal(() => { calls += 1; return Promise.resolve(); });
    } finally {
      await reserved();
    }
  });
  const root = Object.freeze({});
  const registration = internal_DO_NOT_USE_enrollManagedRoot(root);
  expect(internal_DO_NOT_USE_enrollManagedRoot(root)).toBe(registration);
  expect(registration.cohort).toBe("NOT_ESTABLISHED");
  expect(() => queued.runOriginal(() => { calls += 1; return Promise.resolve(); })).toThrow(ManagedRootAdmissionUnavailableError);
  expect(() => queued.reserveOriginalCleanup(() => Promise.resolve())).toThrow(ManagedRootAdmissionUnavailableError);
  release();
  await expect(original).rejects.toBeInstanceOf(ManagedRootAdmissionUnavailableError);
  expect(calls).toBe(0);
  expect(cleanupCalls).toBe(2);
  expect(queued.complete().status).toBe("PINNED");
  registration.revoke();
  expect(() => internal_DO_NOT_USE_beginManagedRootEffect("after revoke")).toThrow(ManagedRootAdmissionUnavailableError);
});
