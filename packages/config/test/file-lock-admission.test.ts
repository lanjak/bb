import { expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  unlock: vi.fn(),
  tryLock: vi.fn(() => true),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  open: vi.fn(async () => ({ fd: 17, close: controls.close })),
  stat: vi.fn(),
  lstat: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({ tryLock: controls.tryLock, unlock: controls.unlock }),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => { throw new Error("Unexpected retry"); }) }));

it.each(["unlock", "close", "both", "unlock undefined"])("rejects successful work on %s cleanup failure and pins the original owner", async (failure) => {
  controls.close.mockReset().mockResolvedValue(undefined);
  controls.unlock.mockReset();
  const first = new Error("original unlock failure");
  const second = new Error("original close failure");
  if (failure !== "close") controls.unlock.mockImplementationOnce(() => { throw failure === "unlock undefined" ? undefined : first; });
  if (failure === "close" || failure === "both") controls.close.mockRejectedValueOnce(second);
  const { withFileLock } = await import("../src/file-lock.js");
  const admission = await vi.importActual<typeof import("../src/managed-root-admission.js")>("../src/managed-root-admission.js");
  const effect = admission.internal_DO_NOT_USE_beginManagedRootEffect("successful original work");
  const work = vi.fn(async () => 17);
  const result = withFileLock({ path: "/synthetic/lock", timeoutMs: 1, work, managedRootEffect: effect });
  await expect(result).rejects.toBe(failure === "close" ? second : failure === "unlock undefined" ? undefined : first);
  expect(work).toHaveBeenCalledTimes(1);
  expect(controls.unlock).toHaveBeenCalledTimes(1);
  expect(controls.close).toHaveBeenCalledTimes(1);
  expect(effect.complete().status).toBe("PINNED");
});

it("preserves an undefined original body rejection while joining both failed cleanup steps", async () => {
  const unlockFailure = new Error("unlock failure");
  controls.unlock.mockReset().mockImplementationOnce(() => { throw unlockFailure; });
  controls.close.mockReset().mockRejectedValueOnce(new Error("close failure"));
  const { withFileLock } = await import("../src/file-lock.js");
  const admission = await vi.importActual<typeof import("../src/managed-root-admission.js")>("../src/managed-root-admission.js");
  const effect = admission.internal_DO_NOT_USE_beginManagedRootEffect("failed original work");
  await expect(withFileLock({ path: "/synthetic/lock", timeoutMs: 1, managedRootEffect: effect, work: async () => { throw undefined; } })).rejects.toBeUndefined();
  expect(controls.unlock).toHaveBeenCalledTimes(1);
  expect(controls.close).toHaveBeenCalledTimes(1);
  expect(effect.complete()).toEqual({ status: "PINNED", failures: [undefined, unlockFailure] });
});
