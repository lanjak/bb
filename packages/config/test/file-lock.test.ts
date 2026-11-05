import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  FileLockTimeoutError,
  internal_DO_NOT_USE_acquireDirectoryLease,
  withFileLock,
} from "../src/file-lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.skipIf(process.platform !== "linux")("memoizes an undefined original close failure and quarantines the physical root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-failed-lease-close-"));
  let bodyFailed = false;
  let bodyFailure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  let callThrough: Awaited<ReturnType<typeof open>> | undefined;
  let failedHandle: Awaited<ReturnType<typeof open>> | undefined;
  let originalClose: (() => Promise<void>) | undefined;
  let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
  let openSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalImplementation: typeof fs.open | undefined;
  let lease: Awaited<ReturnType<typeof internal_DO_NOT_USE_acquireDirectoryLease>> | undefined;
  let injectedCloseObserved = false;
  try {
    const { open: originalOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    callThrough = await originalOpen(join(directory, "call-through"), "w", 0o600);
    await callThrough.close();
    callThrough = undefined;
    originalImplementation = vi.mocked(fs.open).getMockImplementation();
    let openCalls = 0;
    openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (++openCalls > 4) throw new Error("Unexpected recursive open in fault fixture");
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("/.worker-generation.lock")) {
        failedHandle = handle;
        originalClose = handle.close;
        closeSpy = vi.spyOn(handle, "close").mockImplementation(async () => {
          injectedCloseObserved = true;
          throw undefined;
        });
      }
      return handle;
    });
    lease = await internal_DO_NOT_USE_acquireDirectoryLease(directory);
    expect(failedHandle?.fd).toBe(lease.fd);
    const outcome = lease.close();
    expect(lease.close()).toBe(outcome);
    await expect(outcome).rejects.toBeUndefined();
    expect(lease.close()).toBe(outcome);
    await expect(internal_DO_NOT_USE_acquireDirectoryLease(directory)).rejects.toThrow("uncertain generation custody");
  } catch (error) { bodyFailed = true; bodyFailure = error; } finally {
    const attempts = [
      async () => {
        if (lease === undefined) return;
        try { await lease.close(); } catch (error) {
          if (!injectedCloseObserved || error !== undefined) throw error;
        }
      },
      async () => { openSpy?.mockRestore(); },
      async () => { if (originalImplementation !== undefined) vi.mocked(fs.open).mockImplementation(originalImplementation); },
      async () => { closeSpy?.mockRestore(); },
      async () => { if (failedHandle !== undefined && originalClose !== undefined) await Reflect.apply(originalClose, failedHandle, []); },
      async () => { if (callThrough !== undefined) await callThrough.close(); },
      async () => { await rm(directory, { recursive: true, force: true }); },
    ];
    for (const cleanup of attempts) {
      try { await cleanup(); } catch (error) {
        if (!cleanupFailed) { cleanupFailed = true; cleanupFailure = error; }
      }
    }
  }
  if (bodyFailed) throw bodyFailure;
  if (cleanupFailed) throw cleanupFailure;
});

it.skipIf(process.platform !== "linux")("keeps the inherited FD4 lease after closing the helper parent reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-inherited-lease-"));
  const lease = await internal_DO_NOT_USE_acquireDirectoryLease(directory);
  const child = spawn(process.execPath, ["-e", 'require("node:fs").fstatSync(4); process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    stdio: ["ignore", "pipe", "pipe", "ignore", lease.fd],
  });
  const closed = once(child, "close");
  try {
    const ready = await Promise.race([
      once(child.stdout!, "data").then(([data]) => String(data)),
      closed.then(() => { throw new Error("Inherited holder closed before readiness"); }),
    ]);
    expect(ready).toBe("ready");
    const firstClose = lease.close();
    expect(lease.close()).toBe(firstClose);
    await firstClose;
    await expect(internal_DO_NOT_USE_acquireDirectoryLease(directory)).rejects.toThrow();
    child.kill("SIGKILL");
    await closed;
    const next = await internal_DO_NOT_USE_acquireDirectoryLease(directory);
    await next.close();
  } finally {
    child.kill("SIGKILL");
    await closed;
    await lease.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("excludes a second directory lease without unlinking its sentinel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-directory-lease-"));
  const lease = await internal_DO_NOT_USE_acquireDirectoryLease(directory);
  try {
    await expect(internal_DO_NOT_USE_acquireDirectoryLease(directory)).rejects.toThrow();
    await lease.validate();
  } finally {
    await lease.close();
  }
  const next = await internal_DO_NOT_USE_acquireDirectoryLease(directory);
  await next.close();
  await rm(directory, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("shares exclusion through a directory alias and rejects replaced entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-directory-alias-"));
  const alias = `${directory}-alias`;
  await symlink(directory, alias);
  const lease = await internal_DO_NOT_USE_acquireDirectoryLease(directory);
  try {
    await expect(internal_DO_NOT_USE_acquireDirectoryLease(alias)).rejects.toThrow();
    await rename(join(directory, ".worker-generation.lock"), join(directory, "original"));
    await writeFile(join(directory, ".worker-generation.lock"), "", { mode: 0o600 });
    await expect(lease.validate()).rejects.toThrow();
  } finally {
    await lease.close();
    await rm(alias);
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("refuses symbolic and hard-linked sentinel entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-directory-links-"));
  const target = join(directory, "target");
  const sentinel = join(directory, ".worker-generation.lock");
  try {
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, sentinel);
    await expect(internal_DO_NOT_USE_acquireDirectoryLease(directory)).rejects.toThrow();
    await rm(sentinel);
    await link(target, sentinel);
    await expect(internal_DO_NOT_USE_acquireDirectoryLease(directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("excludes another process and releases a native lock when its owner dies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-lock 日本語 "));
  const path = join(directory, "config.lock");
  const moduleUrl = new URL("../src/file-lock.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { withFileLock } from ${JSON.stringify(moduleUrl)};
     await withFileLock({ path: ${JSON.stringify(path)}, timeoutMs: 1000, work: async () => {
       process.stdout.write("locked");
       await new Promise(() => setInterval(() => {}, 1000));
     }});`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => String(chunk)),
    closed.then(() => {
      throw new Error("Lock owner exited before acquiring the lock");
    }),
  ]);
  expect(ready).toBe("locked");
  let entered = false;
  await expect(
    withFileLock({
      path,
      timeoutMs: 100,
      work: async () => {
        entered = true;
      },
    }),
  ).rejects.toBeInstanceOf(FileLockTimeoutError);
  expect(entered).toBe(false);
  child.kill("SIGKILL");
  await closed;
  await expect(
    withFileLock({ path, timeoutMs: 1000, work: async () => "reacquired" }),
  ).resolves.toBe("reacquired");
}, 15_000);
