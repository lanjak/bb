import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
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
  const tempPath = join(directory, `.${basename(args.path)}.tmp`);
  let ownsTemporary = false;
  const cleanup = effect.reserveOriginalCleanup(async () => {
    if (ownsTemporary) await unlink(tempPath);
  });
  try {
    await effect.runOriginal(() => mkdir(directory, { recursive: true }));
    const lockPath = join(directory, `.${basename(args.path)}.lock`);
    return await withFileLock({
      path: lockPath,
      timeoutMs: LOCK_TIMEOUT_MS,
      managedRootEffect: effect,
      work: async () => {
        try {
          const current = await effect.runOriginal(args.read);
          effect.assertOriginalAtDequeue();
          const next = args.mutate(current);
          const encoded = `${JSON.stringify(next, null, 2)}\n`;
          await effect.runOriginal(() => writeFile(tempPath, encoded, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          }));
          ownsTemporary = true;
          await effect.runOriginal(() => rename(tempPath, args.path));
          ownsTemporary = false;
          return next;
        } finally {
          try { await cleanup(); } catch {}
        }
      },
    });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      throw new Error(
        `Timed out waiting to update ${args.path}; another bb command is updating it. Retry the command.`,
      );
    }
    throw error;
  } finally {
    try { await cleanup(); } catch {}
    if (args.managedRootEffect === undefined) effect.complete();
  }
}
