import fs, { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { copyVerifiedFile } from "../src/index.js";

describe("copyVerifiedFile", () => {
  it("preserves a successfully written destination when reserved cleanup settles", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const chmod = vi.fn(async () => {});
    const write = vi.fn(async () => ({ bytesWritten: 3 }));
    type Handle = Awaited<ReturnType<typeof fs.open>>;
    const handle = { close, sync, chmod, write } as Handle;
    const open = vi.spyOn(fs, "open").mockResolvedValue(handle);
    const rm = vi.spyOn(fs, "rm").mockRejectedValue(new Error("Unexpected removal"));
    const transfer = await import("../src/verified-file-transfer.js");
    try {
      const written = await transfer.writeVerifiedFile({ destinationPath: "/unresolved/file", durable: true, expected: { maxBytes: 3, sha256: null, sizeBytes: 3 }, label: "test", mode: { kind: "preserve", mode: 0o600 }, source: [Buffer.from("new")] });
      expect(written.sizeBytes).toBe(3);
      expect(close).toHaveBeenCalledOnce();
      expect(sync).toHaveBeenCalledOnce();
      expect(chmod).toHaveBeenCalledOnce();
      expect(rm).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      rm.mockRestore();
    }
  });

  it("preserves an undefined source failure when original removal also fails", async () => {
    const close = vi.fn(async () => {});
    const nativeOpen = fs.open;
    type Handle = Awaited<ReturnType<typeof nativeOpen>>;
    const handle = { close } as Handle;
    const open = vi.spyOn(fs, "open").mockResolvedValue(handle);
    const rm = vi.spyOn(fs, "rm").mockRejectedValue(new Error("Cleanup failed"));
    const transfer = await import("../src/verified-file-transfer.js");
    let failed = false;
    let reason: unknown;
    try {
      await transfer.writeVerifiedFile({ destinationPath: "/unresolved/file", durable: false, expected: { maxBytes: 0, sha256: null, sizeBytes: 0 }, label: "test", mode: { kind: "create", mode: 0o600 }, source: (async function* () { throw undefined; })() });
    } catch (error) {
      failed = true;
      reason = error;
    } finally {
      open.mockRestore();
      rm.mockRestore();
    }
    expect(failed).toBe(true);
    expect(reason).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(rm).toHaveBeenCalledOnce();
  });

  it("refuses direct verified writes and publication before native access in selected mode", async () => {
    vi.resetModules();
    const admission = await import("@bb/config/file-lock");
    const transfer = await import("../src/verified-file-transfer.js");
    const open = vi.spyOn(fs, "open").mockRejectedValue(new Error("Unexpected open"));
    const link = vi.spyOn(fs, "link").mockRejectedValue(new Error("Unexpected link"));
    admission.internal_DO_NOT_USE_enrollManagedRoot({});
    try {
      await expect(transfer.writeVerifiedFile({ destinationPath: "/unresolved/file", durable: true, expected: { maxBytes: 0, sha256: null, sizeBytes: 0 }, label: "test", mode: { kind: "create", mode: 0o600 }, source: [] })).rejects.toBeInstanceOf(admission.ManagedRootAdmissionUnavailableError);
      await expect(transfer.publishFileWithoutReplacing("/unresolved/source", "/unresolved/destination")).rejects.toBeInstanceOf(admission.ManagedRootAdmissionUnavailableError);
      expect(open).not.toHaveBeenCalled();
      expect(link).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      link.mockRestore();
      vi.resetModules();
    }
  });

  it("rejects a missing source without leaving a destination file", async () => {
    const root = await makeTempDir();
    const destinationPath = path.join(root, "copy.bin");

    await expect(
      copyVerifiedFile({
        destinationPath,
        expected: { maxBytes: 4, sha256: null, sizeBytes: 4 },
        label: "Missing file",
        mode: 0o644,
        sourcePath: path.join(root, "missing.bin"),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not leave an unhandled source error when the destination cannot be created", async () => {
    const root = await makeTempDir();
    const destinationPath = path.join(root, "existing.bin");
    await writeFile(destinationPath, "keep");

    await expect(
      copyVerifiedFile({
        destinationPath,
        expected: { maxBytes: 4, sha256: null, sizeBytes: 4 },
        label: "Missing file",
        mode: 0o644,
        sourcePath: path.join(root, "missing.bin"),
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("keep");
  });
});
