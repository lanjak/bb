import { createHash } from "node:crypto";
import { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { replaceFile } from "../src/index.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function withRestoredMocks(body: () => Promise<void>, restores: (() => void)[]): Promise<void> {
  let failed = false;
  let reason: unknown;
  try { await body(); } catch (error) { failed = true; reason = error; }
  for (const restore of restores) {
    try { restore(); } catch (error) { if (!failed) { failed = true; reason = error; } }
  }
  if (failed) throw reason;
}

describe("replaceFile", () => {
  it("keeps the original target and bytes through a denied temporary creation", async () => {
    const args = { path: "/original/file", contents: Buffer.from("new") };
    const stat = vi.spyOn(fs, "stat").mockResolvedValue(new Stats());
    const read = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("old"));
    const open = vi.spyOn(fs, "open").mockImplementation(async () => {
      args.path = "/foreign/ancestor";
      args.contents.fill(0);
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    });
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const rm = vi.spyOn(fs, "rm").mockRejectedValue(new Error("Unexpected removal"));
    await withRestoredMocks(async () => {
      await expect(replaceFile(args)).resolves.toEqual({
        outcome: "written",
        sha256: sha256("new"),
        sizeBytes: 3,
      });
      expect(write).toHaveBeenCalledExactlyOnceWith("/original/file", Buffer.from("new"));
      expect(rm).not.toHaveBeenCalled();
    }, [() => stat.mockRestore(), () => read.mockRestore(), () => open.mockRestore(), () => write.mockRestore(), () => rm.mockRestore()]);
  });

  it.each(["revision", "create-only"] as const)(
    "refuses the final %s hash read after enrollment without turning denial into a conflict",
    async (kind) => {
      vi.resetModules();
      const admission = await import("@bb/config/file-lock");
      const { replaceFile: replace } = await import("../src/replace-file.js");
      const enroll = () => { admission.internal_DO_NOT_USE_enrollManagedRoot({}); };
      const stat = vi.spyOn(fs, "stat");
      if (kind === "revision") stat.mockResolvedValue(new Stats());
      else stat.mockRejectedValue(Object.assign(new Error("Missing target"), { code: "ENOENT" }));
      const read = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("old"));
      const close = vi.fn(async () => {});
      const sync = vi.fn(async () => { if (kind === "revision") enroll(); });
      const chmod = vi.fn(async () => {});
      const write = vi.fn(async () => ({ bytesWritten: 3 }));
      type Handle = Awaited<ReturnType<typeof fs.open>>;
      const open = vi.spyOn(fs, "open").mockResolvedValue({ close, sync, chmod, write } as Handle);
      const link = vi.spyOn(fs, "link").mockImplementation(async () => {
        enroll();
        throw Object.assign(new Error("Target appeared"), { code: "EEXIST" });
      });
      const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("Unexpected rename"));
      const rm = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
      await withRestoredMocks(async () => {
        await expect(replace({
          path: "/original/file",
          contents: Buffer.from("new"),
          expectedSha256: kind === "revision" ? sha256("old") : null,
        })).rejects.toBeInstanceOf(admission.ManagedRootAdmissionUnavailableError);
        expect(read).toHaveBeenCalledTimes(kind === "revision" ? 1 : 0);
        if (kind === "revision") expect(read).toHaveBeenCalledExactlyOnceWith("/original/file");
        expect(write).toHaveBeenCalledOnce();
        expect(sync).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(link).toHaveBeenCalledTimes(kind === "revision" ? 0 : 1);
        expect(rename).not.toHaveBeenCalled();
        const temporaryPath = open.mock.calls[0]?.[0];
        expect(temporaryPath).toEqual(expect.stringMatching(/^\/original\/\.bb-write-/));
        expect(rm).toHaveBeenCalledExactlyOnceWith(temporaryPath, { force: true });
      }, [() => stat.mockRestore(), () => read.mockRestore(), () => open.mockRestore(), () => link.mockRestore(), () => rename.mockRestore(), () => rm.mockRestore(), () => vi.resetModules()]);
    },
  );

  it("keeps the original target when the caller mutates its request during stat", async () => {
    const args = { path: "/original/file", contents: Buffer.from("new") };
    const failure = new Error("Stop before publication");
    const stat = vi.spyOn(fs, "stat").mockImplementation(async () => {
      args.path = "/foreign/ancestor";
      return new Stats();
    });
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(failure);
    await withRestoredMocks(async () => {
      await expect(replaceFile(args)).rejects.toBe(failure);
      expect(read).toHaveBeenCalledExactlyOnceWith("/original/file");
    }, [() => stat.mockRestore(), () => read.mockRestore()]);
  });

  it("refuses the next read when enrollment occurs during the original stat", async () => {
    vi.resetModules();
    const admission = await import("@bb/config/file-lock");
    const { replaceFile: replace } = await import("../src/replace-file.js");
    const stat = vi.spyOn(fs, "stat").mockImplementation(async () => {
      admission.internal_DO_NOT_USE_enrollManagedRoot({});
      return new Stats();
    });
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected read"));
    await withRestoredMocks(async () => {
      await expect(replace({ path: "/original/file", contents: Buffer.from("new") })).rejects.toBeInstanceOf(admission.ManagedRootAdmissionUnavailableError);
      expect(read).not.toHaveBeenCalled();
    }, [() => stat.mockRestore(), () => read.mockRestore(), () => vi.resetModules()]);
  });

  it("does not remove a temporary path when exclusive creation reports EEXIST", async () => {
    const stat = vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("Missing target"), { code: "ENOENT" }));
    const open = vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error("Existing temporary file"), { code: "EEXIST" }));
    const rm = vi.spyOn(fs, "rm").mockRejectedValue(new Error("Unexpected removal"));
    try {
      await expect(replaceFile({ path: "/unresolved/file", contents: Buffer.from("new") })).rejects.toMatchObject({ code: "EEXIST" });
      expect(rm).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      open.mockRestore();
      rm.mockRestore();
    }
  });

  it("refuses direct replacement before filesystem access in selected mode", async () => {
    vi.resetModules();
    const admission = await import("@bb/config/file-lock");
    const { replaceFile: replace } = await import("../src/replace-file.js");
    const stat = vi.spyOn(fs, "stat").mockRejectedValue(new Error("Unexpected stat"));
    admission.internal_DO_NOT_USE_enrollManagedRoot({});
    try {
      await expect(replace({ path: "/unresolved/file", contents: Buffer.from("new") })).rejects.toBeInstanceOf(admission.ManagedRootAdmissionUnavailableError);
      expect(stat).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      vi.resetModules();
    }
  });

  it("leaves the original file intact when a write fails midway", async () => {
    const dir = await makeTempDir("bb-replace-file-");
    const target = path.join(dir, "note.md");
    await fs.writeFile(target, "original");
    const diskFull = Object.assign(new Error("no space left on device"), {
      code: "ENOSPC",
    });
    const probe = await fs.open(target, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWriteFile = fs.writeFile;
    const originalHandleWrite = fileHandlePrototype.write;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data) => {
      await originalWriteFile(file, String(data).slice(0, 3));
      throw diskFull;
    });
    vi.spyOn(fileHandlePrototype, "write").mockImplementation(async function (
      this: unknown,
      data: unknown,
    ) {
      await originalHandleWrite.call(this, data, 0, 3);
      throw diskFull;
    });

    try {
      await expect(
        replaceFile({ contents: Buffer.from("replacement"), path: target }),
      ).rejects.toBe(diskFull);
    } finally {
      vi.restoreAllMocks();
    }

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    await expect(fs.readdir(dir)).resolves.toEqual(["note.md"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "overwrites in place without a precondition when the parent directory is not writable",
    async () => {
      const dir = await makeTempDir("bb-replace-file-");
      const lockedDir = path.join(dir, "locked");
      await fs.mkdir(lockedDir);
      const target = path.join(lockedDir, "note.md");
      await fs.writeFile(target, "original");
      await fs.chmod(lockedDir, 0o555);

      try {
        await expect(
          replaceFile({ contents: Buffer.from("replacement"), path: target }),
        ).resolves.toEqual({
          outcome: "written",
          sha256: sha256("replacement"),
          sizeBytes: 11,
        });
      } finally {
        await fs.chmod(lockedDir, 0o755);
      }

      await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
      await expect(fs.readdir(lockedDir)).resolves.toEqual(["note.md"]);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a revision-checked save rather than overwrite in place in a read-only directory",
    async () => {
      const dir = await makeTempDir("bb-replace-file-");
      const lockedDir = path.join(dir, "locked");
      await fs.mkdir(lockedDir);
      const target = path.join(lockedDir, "note.md");
      await fs.writeFile(target, "original");
      await fs.chmod(lockedDir, 0o555);

      try {
        await expect(
          replaceFile({
            contents: Buffer.from("replacement"),
            expectedSha256: sha256("original"),
            path: target,
          }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(lockedDir, 0o755);
      }

      await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    },
  );

  it.skipIf(process.platform === "win32")(
    "applies the process umask to a requested mode on new files",
    async () => {
      const dir = await makeTempDir("bb-replace-file-");
      const target = path.join(dir, "shared.txt");
      const umask = process.umask();

      await replaceFile({
        contents: Buffer.from("hello"),
        mode: 0o666,
        path: target,
      });

      expect((await fs.stat(target)).mode & 0o777).toBe(0o666 & ~umask);
    },
  );

  it("saves files whose names are close to the filesystem limit", async () => {
    const dir = await makeTempDir("bb-replace-file-");
    const target = path.join(dir, `${"n".repeat(240)}.md`);
    await fs.writeFile(target, "original");

    await expect(
      replaceFile({ contents: Buffer.from("replacement"), path: target }),
    ).resolves.toMatchObject({ outcome: "written" });
    await expect(fs.readdir(dir)).resolves.toEqual([path.basename(target)]);
  });
});
