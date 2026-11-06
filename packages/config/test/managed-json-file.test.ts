import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  open: vi.fn(async () => ({ writeFile: vi.fn(async () => undefined), close: vi.fn(async () => undefined) })),
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
  vi.mocked(fs.open).mockRejectedValueOnce(foreign);
  await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value })).rejects.toBe(foreign);
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(foreignExists).toBe(true);
  expect(fs.rename).not.toHaveBeenCalled();
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.rename).mockRejectedValueOnce(undefined);
  vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("cleanup failure"));
  const failed = mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value });
  await expect(failed).rejects.toBeInstanceOf(AggregateError);
  await failed.catch((error: AggregateError) => expect(error.errors[0]).toBeUndefined());
  expect(fs.unlink).toHaveBeenCalledTimes(1);
});

it("refuses publication when serialization enrolls a root synchronously", async () => {
  vi.resetModules();
  try {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.rename).mockClear();
    const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
    const { internal_DO_NOT_USE_enrollManagedRoot } = await import("@bb/config/internal-managed-root-admission");
    const value = { toJSON() {
      internal_DO_NOT_USE_enrollManagedRoot(Object.freeze({}));
      return {};
    } };
    await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => value, mutate: (current) => current })).rejects.toThrow("cohort NOT_ESTABLISHED");
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
  } finally {
    vi.resetModules();
  }
});

it("rechecks the same original effect after read awaits and allows only preowned cleanup", async () => {
  const fs = await import("node:fs/promises");
  vi.mocked(fs.open).mockClear();
  vi.mocked(fs.rename).mockClear();
  const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
  const { internal_DO_NOT_USE_beginManagedRootEffect, internal_DO_NOT_USE_enrollManagedRoot } = await import("@bb/config/internal-managed-root-admission");
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
  expect(fs.open).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  expect(effect.complete().status).toBe("PINNED");
});

it("closes the original handle and removes its temporary file after a partial write", async () => {
  vi.resetModules();
  const fs = await import("node:fs/promises");
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.rename).mockReset();
  const failure = new Error("partial write");
  const close = vi.fn(async () => undefined);
  const writeFile = vi.fn(async () => { throw failure; });
  vi.mocked(fs.open).mockResolvedValueOnce({ writeFile, close } as Awaited<ReturnType<typeof fs.open>>);
  const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
  await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value })).rejects.toBe(failure);
  expect(writeFile).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(fs.unlink).toHaveBeenCalledTimes(1);
  expect(fs.rename).not.toHaveBeenCalled();
});

it("joins original close and unlink failures without retrying the handle close", async () => {
  vi.resetModules();
  const fs = await import("node:fs/promises");
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.rename).mockReset();
  const closeFailure = new Error("close failure");
  const unlinkFailure = new Error("unlink failure");
  const close = vi.fn(async () => { throw closeFailure; });
  vi.mocked(fs.open).mockResolvedValueOnce({ writeFile: vi.fn(async () => undefined), close } as Awaited<ReturnType<typeof fs.open>>);
  vi.mocked(fs.unlink).mockRejectedValueOnce(unlinkFailure);
  const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
  const result = mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value });
  await expect(result).rejects.toBeInstanceOf(AggregateError);
  await result.catch((error: AggregateError) => {
    expect(error.errors).toContain(closeFailure);
    expect(error.errors).toContain(unlinkFailure);
  });
  expect(close).toHaveBeenCalledTimes(1);
  expect(fs.rename).not.toHaveBeenCalled();
});

it("takes original handle custody before an acquisition-time enrollment refuses the write", async () => {
  vi.resetModules();
  const fs = await import("node:fs/promises");
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.rename).mockReset();
  const { internal_DO_NOT_USE_enrollManagedRoot } = await import("@bb/config/internal-managed-root-admission");
  const close = vi.fn(async () => undefined);
  const writeFile = vi.fn(async () => undefined);
  vi.mocked(fs.open).mockImplementationOnce(async () => {
    internal_DO_NOT_USE_enrollManagedRoot(Object.freeze({}));
    return { writeFile, close } as Awaited<ReturnType<typeof fs.open>>;
  });
  const { mutateManagedJsonFile } = await import("../src/managed-json-file.js");
  await expect(mutateManagedJsonFile({ path: "/unopened/settings.json", read: async () => ({}), mutate: (value) => value })).rejects.toThrow("cohort NOT_ESTABLISHED");
  expect(close).toHaveBeenCalledTimes(1);
  expect(fs.unlink).toHaveBeenCalledTimes(1);
  expect(writeFile).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  vi.resetModules();
});
