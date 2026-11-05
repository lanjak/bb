import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("../src/file-lock.js", async () => {
  class FileLockTimeoutError extends Error {}
  return { FileLockTimeoutError, withFileLock: vi.fn(async (args: { work: () => Promise<unknown> }) => args.work()) };
});

it("preserves a foreign temporary file and opaque primary failure while joining original cleanup", async () => {
  const fs = await import("node:fs/promises");
  const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
  const foreign = Object.assign(new Error("foreign temporary file"), { code: "EEXIST" });
  let foreignExists = true;
  vi.mocked(fs.unlink).mockImplementationOnce(async () => { foreignExists = false; });
  vi.mocked(fs.writeFile).mockImplementationOnce(async () => {
    if (foreignExists) throw foreign;
  });
  await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value })).rejects.toBe(foreign);
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(foreignExists).toBe(true);
  expect(fs.rename).not.toHaveBeenCalled();
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.rename).mockRejectedValueOnce(undefined);
  vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("cleanup failure"));
  await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value })).rejects.toBeUndefined();
  expect(fs.unlink).toHaveBeenCalledTimes(1);
});

it("refuses publication when serialization enrolls a root synchronously", async () => {
  vi.resetModules();
  try {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockClear();
    vi.mocked(fs.rename).mockClear();
    const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
    const { internal_DO_NOT_USE_enrollManagedRoot } = await import("../src/managed-root-admission.js");
    const value = { toJSON() {
      internal_DO_NOT_USE_enrollManagedRoot(Object.freeze({}));
      return {};
    } };
    await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => value, mutate: (current) => current })).rejects.toThrow("cohort NOT_ESTABLISHED");
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
  } finally {
    vi.resetModules();
  }
});

it("rechecks the same original effect after read awaits and allows only preowned cleanup", async () => {
  const fs = await import("node:fs/promises");
  vi.mocked(fs.writeFile).mockClear();
  vi.mocked(fs.rename).mockClear();
  const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
  const { internal_DO_NOT_USE_beginManagedRootEffect, internal_DO_NOT_USE_enrollManagedRoot } = await import("../src/managed-root-admission.js");
  const effect = internal_DO_NOT_USE_beginManagedRootEffect("JSON caller");
  let finishRead!: (value: object) => void;
  let observedRead!: () => void;
  const started = new Promise<void>((resolve) => { observedRead = resolve; });
  const read = new Promise<object>((resolve) => { finishRead = resolve; });
  const result = mutateManagedJsonFile({ path: "/unopened/settings.json", managedRootEffect: effect, read: () => { observedRead(); return read; }, mutate: (value) => value });
  await started;
  internal_DO_NOT_USE_enrollManagedRoot(Object.freeze({}));
  finishRead({});
  await expect(result).rejects.toThrow("cohort NOT_ESTABLISHED");
  expect(fs.writeFile).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  expect(effect.complete().status).toBe("PINNED");
});
