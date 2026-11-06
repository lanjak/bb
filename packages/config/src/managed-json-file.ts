import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FileLockTimeoutError, withFileLock } from "./file-lock.js";
import { internal_DO_NOT_USE_beginManagedRootEffect, type ManagedRootEffect } from "@bb/config/internal-managed-root-admission";

const LOCK_TIMEOUT_MS = 5_000;

export async function mutateManagedJsonFile<T extends object>(args: {
  path: string;
  read: () => Promise<T>;
  mutate: (current: T) => T;
  managedRootEffect?: ManagedRootEffect;
}): Promise<T> {
  const effect = args.managedRootEffect ?? internal_DO_NOT_USE_beginManagedRootEffect("managed JSON mutation");
  effect.assertOriginalAtDequeue();
  const directory = dirname(args.path);
  const tempPath = join(directory, `.${basename(args.path)}.${randomUUID()}.tmp`);
  let ownsTemporary = false;
  let temporaryHandle: FileHandle | undefined;
  let closePromise: Promise<void> | undefined;
  const closeOriginal = (): Promise<void> => {
    if (!temporaryHandle) return Promise.resolve();
    closePromise ??= Promise.resolve().then(() => temporaryHandle!.close());
    return closePromise;
  };
  const cleanupFailures: unknown[] = [];
  const cleanup = effect.reserveOriginalCleanup(async () => {
    try {
      await closeOriginal();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (ownsTemporary) {
      try {
        await unlink(tempPath);
        ownsTemporary = false;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Temporary file cleanup failed");
  });
  let primaryPresent = false;
  let primary: unknown;
  let result: T | undefined;
  try {
    await effect.runOriginal(() => mkdir(directory, { recursive: true }));
    const lockPath = join(directory, `.${basename(args.path)}.lock`);
    result = await withFileLock({
      path: lockPath,
      timeoutMs: LOCK_TIMEOUT_MS,
      managedRootEffect: effect,
      work: async () => {
        const current = await effect.runOriginal(args.read);
        effect.assertOriginalAtDequeue();
        const next = args.mutate(current);
        const encoded = `${JSON.stringify(next, null, 2)}\n`;
        await effect.runOriginal(async () => {
          temporaryHandle = await open(tempPath, "wx", 0o600);
          ownsTemporary = true;
        });
        await effect.runOriginal(() => temporaryHandle!.writeFile(encoded, "utf8"));
        await effect.runOriginal(closeOriginal);
        await effect.runOriginal(() => rename(tempPath, args.path));
        ownsTemporary = false;
        return next;
      },
    });
  } catch (error) {
    primaryPresent = true;
    primary = error instanceof FileLockTimeoutError
      ? new Error(`Timed out waiting to update ${args.path}; another bb command is updating it. Retry the command.`)
      : error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!cleanupFailures.length) cleanupFailures.push(error);
  } finally {
    if (args.managedRootEffect === undefined) effect.complete();
  }
  if (cleanupFailures.length) throw new AggregateError(primaryPresent ? [primary, ...cleanupFailures] : cleanupFailures, "Managed JSON operation cleanup failed");
  if (primaryPresent) throw primary;
  return result!;
}
