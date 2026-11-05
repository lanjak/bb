import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureThreadStorageRoot } from "./thread-storage-root.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("thread storage root", () => {
  it("refuses selected startup storage before mkdir", async () => {
    vi.resetModules();
    const admission = await import("@bb/config/file-lock");
    const { ensureThreadStorageRoot: ensure } = await import("./thread-storage-root.js");
    const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("Unexpected mkdir"));
    admission.internal_DO_NOT_USE_enrollManagedRoot({});
    try {
      await expect(ensure("/unresolved/data")).rejects.toBeInstanceOf(admission.ManagedRootAdmissionUnavailableError);
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      vi.resetModules();
    }
  });

  it("creates thread-storage under the host data dir, not a parent thread's ambient storage path", async () => {
    const dataDir = await makeTempDir("bb-thread-storage-root-data-");
    const parentStorageRoot = await makeTempDir(
      "bb-thread-storage-root-parent-",
    );
    vi.stubEnv("BB_THREAD_STORAGE", path.join(parentStorageRoot, "thr_parent"));

    const rootPath = await ensureThreadStorageRoot(dataDir);

    expect(rootPath).toBe(path.join(dataDir, "thread-storage"));
    expect((await fs.stat(rootPath)).isDirectory()).toBe(true);
  });
});
