import fs from "node:fs/promises";
import path from "node:path";
import { internal_DO_NOT_USE_beginManagedRootEffect } from "@bb/config/file-lock";

function threadStorageRootPath(dataDir: string): string {
  return path.join(dataDir, "thread-storage");
}

export async function ensureThreadStorageRoot(
  dataDir: string,
): Promise<string> {
  const effect = internal_DO_NOT_USE_beginManagedRootEffect("ensureThreadStorageRoot");
  try {
    const rootPath = threadStorageRootPath(dataDir);
    await effect.runOriginal(() => fs.mkdir(rootPath, { recursive: true }));
    return rootPath;
  } finally {
    effect.complete();
  }
}
