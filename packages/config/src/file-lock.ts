import { constants } from "node:fs";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { internal_DO_NOT_USE_beginManagedRootEffect, type ManagedRootEffect } from "./managed-root-admission.js";

export {
  internal_DO_NOT_USE_enrollManagedRoot,
  internal_DO_NOT_USE_assertManagedRootAdmission,
  internal_DO_NOT_USE_beginManagedRootEffect,
  ManagedRootAdmissionUnavailableError,
  type ManagedRootRegistration,
  type ManagedRootEffect,
} from "./managed-root-admission.js";

const LOCK_RETRY_MS = 25;
interface NativeFileLocks {
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
}

const uncertainDirectoryLeases = new Map<string, Set<object>>();

export async function internal_DO_NOT_USE_acquireDirectoryLease(path: string, managedRootEffect?: ManagedRootEffect) {
  const effect = managedRootEffect ?? internal_DO_NOT_USE_beginManagedRootEffect("directory lease acquisition");
  effect.assertOriginalAtDequeue();
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("Directory generation leases require verified Linux OFD locks");
  }
  const native = loadNativeFileLocks();
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: string | undefined;
  let closePromise: Promise<void> | undefined;
  const owner = { directory, get handle() { return handle; }, failures: [] as unknown[], custody: [] as object[] };
  const quarantine = (custody?: object) => {
    if (custody !== undefined) owner.custody.push(custody);
    const key = identity ?? path;
    let retained = uncertainDirectoryLeases.get(key);
    if (retained === undefined) {
      retained = new Set();
      uncertainDirectoryLeases.set(key, retained);
    }
    retained.add(owner);
  };
  const closeOriginal = effect.reserveOriginalCleanup(async () => {
    let failed = false;
    let primary: unknown;
    for (const originalHandle of [handle, directory]) {
      if (originalHandle === undefined) continue;
      try { await originalHandle.close(); } catch (error) {
        if (!failed) { failed = true; primary = error; }
        owner.failures.push(error);
      }
    }
    if (failed) { quarantine(); throw primary; }
  });
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = closeOriginal().finally(() => {
      if (managedRootEffect === undefined) effect.complete();
    });
    return closePromise;
  };
  try {
    const originalDirectory = await effect.runOriginal(() => open(path, constants.O_RDONLY | constants.O_DIRECTORY));
    directory = originalDirectory;
    const original = await effect.runOriginal(() => originalDirectory.stat());
    identity = `${original.dev}:${original.ino}`;
    if (uncertainDirectoryLeases.has(identity) || uncertainDirectoryLeases.has(path)) {
      throw new Error("Host data directory has uncertain generation custody");
    }
    const uid = process.getuid();
    if (original.uid !== uid || (original.mode & 0o077) !== 0) {
      throw new Error("Host data directory must be privately owned");
    }
    const entry = join(path, ".worker-generation.lock");
    const boundEntry = `/proc/self/fd/${directory.fd}/.worker-generation.lock`;
    const sentinel = await effect.runOriginal(() => open(boundEntry, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
    handle = sentinel;
    const originalLeaf = await effect.runOriginal(() => sentinel.stat());
    const validate = async () => {
      const [currentDirectory, leaf, currentEntry, boundLeaf] = await effect.runOriginal(() => Promise.all([
        stat(path), sentinel.stat(), lstat(entry), lstat(boundEntry),
      ]));
      effect.assertOriginalAtDequeue();
      if (
        currentDirectory.dev !== original.dev || currentDirectory.ino !== original.ino ||
        currentDirectory.uid !== uid || (currentDirectory.mode & 0o077) !== 0 ||
        !leaf.isFile() || leaf.uid !== uid || (leaf.mode & 0o7777) !== 0o600 || leaf.nlink !== 1 ||
        leaf.dev !== originalLeaf.dev || leaf.ino !== originalLeaf.ino ||
        !currentEntry.isFile() || currentEntry.dev !== leaf.dev || currentEntry.ino !== leaf.ino ||
        !boundLeaf.isFile() || boundLeaf.dev !== leaf.dev || boundLeaf.ino !== leaf.ino
      ) throw new Error("Host generation lease identity or ownership changed");
    };
    await validate();
    effect.assertOriginalAtDequeue();
    if (!native.tryLock(sentinel.fd)) throw new Error("Host data directory generation is already leased");
    await validate();
    return { fd: sentinel.fd, validate, close, quarantine };
  } catch (primary) {
    try { await close(); } catch { quarantine(); }
    throw primary;
  }
}

let loadedNativeFileLocks: NativeFileLocks | undefined;

function loadNativeFileLocks(): NativeFileLocks {
  if (loadedNativeFileLocks !== undefined) return loadedNativeFileLocks;
  const value: unknown = createRequire(import.meta.url)("fs-native-extensions");
  if (
    value === null ||
    typeof value !== "object" ||
    !("tryLock" in value) ||
    typeof value.tryLock !== "function" ||
    !("unlock" in value) ||
    typeof value.unlock !== "function"
  ) {
    throw new Error("Invalid fs-native-extensions module");
  }
  const tryLock = value.tryLock;
  const unlock = value.unlock;
  loadedNativeFileLocks = {
    tryLock: (fd) => {
      const result: unknown = Reflect.apply(tryLock, value, [fd]);
      if (typeof result !== "boolean") {
        throw new Error("Invalid fs-native-extensions lock result");
      }
      return result;
    },
    unlock: (fd) => {
      Reflect.apply(unlock, value, [fd]);
    },
  };
  return loadedNativeFileLocks;
}

export class FileLockTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`Timed out waiting for file lock: ${path}`);
  }
}

export async function withFileLock<T>(args: {
  path: string;
  timeoutMs: number;
  work: () => Promise<T>;
  managedRootEffect?: ManagedRootEffect;
}): Promise<T> {
  const effect = args.managedRootEffect ?? internal_DO_NOT_USE_beginManagedRootEffect("file lock");
  effect.assertOriginalAtDequeue();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let acquired = false;
  const cleanup = effect.reserveOriginalCleanup(async () => {
    if (handle === undefined) return;
    let failed = false;
    let primary: unknown;
    try {
      if (acquired) loadNativeFileLocks().unlock(handle.fd);
    } catch (error) {
      failed = true;
      primary = error;
    }
    try { await handle.close(); } catch (error) {
      if (!failed) { failed = true; primary = error; }
    }
    if (failed) throw primary;
  });
  let bodyFailed = false;
  try {
    const nativeFileLocks = loadNativeFileLocks();
    await effect.runOriginal(() => mkdir(dirname(args.path), { recursive: true }));
    const originalHandle = await effect.runOriginal(() => open(args.path, "a+", 0o600));
    handle = originalHandle;
    const deadline = performance.now() + args.timeoutMs;
    for (;;) {
      effect.assertOriginalAtDequeue();
      if (nativeFileLocks.tryLock(originalHandle.fd)) {
        acquired = true;
        break;
      }
      if (performance.now() >= deadline) {
        throw new FileLockTimeoutError(args.path);
      }
      await sleep(LOCK_RETRY_MS);
    }
    return await effect.runOriginal(args.work);
  } catch (primary) {
    bodyFailed = true;
    throw primary;
  } finally {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      if (!bodyFailed) throw cleanupFailure;
    } finally {
      if (args.managedRootEffect === undefined) effect.complete();
    }
  }
}
