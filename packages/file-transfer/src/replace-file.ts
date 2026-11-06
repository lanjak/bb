import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { internal_DO_NOT_USE_beginManagedRootEffect, type ManagedRootEffect } from "@bb/config/file-lock";
import { isFsErrorWithCode } from "./fs-errors.js";
import {
  publishFileWithoutReplacing,
  writeVerifiedFile,
  type VerifiedFileMode,
} from "./verified-file-transfer.js";

const DEFAULT_CREATE_MODE = 0o666;

export type ReplaceFileResult =
  | { outcome: "written"; sha256: string; sizeBytes: number }
  | { outcome: "conflict"; currentSha256: string | null };

interface ReplaceFileArgs {
  contents: Buffer;
  expectedSha256?: string | null;
  mode?: number;
  path: string;
}

function sha256Hex(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function readCurrentSha256(filePath: string): Promise<string | null> {
  const latest = await fs.readFile(filePath).catch(() => null);
  return latest === null ? null : sha256Hex(latest);
}

async function findLatestConflict(
  args: ReplaceFileArgs,
): Promise<ReplaceFileResult | null> {
  if (args.expectedSha256 === undefined) {
    return null;
  }
  const latestSha256 = await readCurrentSha256(args.path);
  return latestSha256 === args.expectedSha256
    ? null
    : { outcome: "conflict", currentSha256: latestSha256 };
}

function writtenResult(contents: Buffer): ReplaceFileResult {
  return {
    outcome: "written",
    sha256: sha256Hex(contents),
    sizeBytes: contents.length,
  };
}

async function publishTemporaryFile(
  args: ReplaceFileArgs,
  temporaryPath: string,
  effect: ManagedRootEffect,
): Promise<ReplaceFileResult> {
  if (args.expectedSha256 === null) {
    if (!(await effect.runOriginal(() => publishFileWithoutReplacing(temporaryPath, args.path)))) {
      return {
        outcome: "conflict",
        currentSha256: await readCurrentSha256(args.path),
      };
    }
    return writtenResult(args.contents);
  }
  const conflict = await findLatestConflict(args);
  if (conflict !== null) {
    return conflict;
  }
  await effect.runOriginal(() => fs.rename(temporaryPath, args.path));
  return writtenResult(args.contents);
}

export async function replaceFile(
  args: ReplaceFileArgs,
): Promise<ReplaceFileResult> {
  const effect = internal_DO_NOT_USE_beginManagedRootEffect("replaceFile");
  try {
    const originalArgs: ReplaceFileArgs = {
      path: args.path,
      contents: Buffer.from(args.contents),
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
    };
    return await effect.runOriginal(() => replaceAdmittedFile(originalArgs, effect));
  } finally {
    effect.complete();
  }
}

async function replaceAdmittedFile(
  args: ReplaceFileArgs,
  effect: ManagedRootEffect,
): Promise<ReplaceFileResult> {
  const temporaryPath = path.join(path.dirname(args.path), `.bb-write-${randomUUID()}`);
  let temporaryStarted = false;
  const cleanup = effect.reserveOriginalCleanup(async () => {
    if (temporaryStarted) await fs.rm(temporaryPath, { force: true });
  });
  try {
  let currentContents: Buffer | null = null;
  let currentMode: number | undefined;
  try {
    currentMode = (await effect.runOriginal(() => fs.stat(args.path))).mode & 0o777;
    currentContents = await effect.runOriginal(() => fs.readFile(args.path));
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
  const currentSha256 =
    currentContents === null ? null : sha256Hex(currentContents);
  if (
    args.expectedSha256 !== undefined &&
    args.expectedSha256 !== currentSha256
  ) {
    return { outcome: "conflict", currentSha256 };
  }

  const preservedMode: VerifiedFileMode | null =
    currentMode === undefined ? null : { kind: "exact", mode: currentMode };
  const requestedMode: VerifiedFileMode | null =
    args.mode === undefined ? null : { kind: "create", mode: args.mode };
  const mode =
    (args.expectedSha256 === undefined
      ? (preservedMode ?? requestedMode)
      : (requestedMode ?? preservedMode)) ??
    ({ kind: "create", mode: DEFAULT_CREATE_MODE } as const);
    try {
      await effect.runOriginal(() => {
        return writeVerifiedFile({
        destinationPath: temporaryPath,
        durable: true,
        expected: {
          maxBytes: args.contents.length,
          sha256: null,
          sizeBytes: args.contents.length,
        },
        label: `File ${args.path}`,
        mode,
        source: [args.contents],
        });
      });
      temporaryStarted = true;
    } catch (error) {
      if (
        currentContents !== null &&
        args.expectedSha256 === undefined &&
        (isFsErrorWithCode(error, "EACCES") ||
          isFsErrorWithCode(error, "EPERM"))
      ) {
        await effect.runOriginal(() => fs.writeFile(args.path, args.contents));
        return writtenResult(args.contents);
      }
      throw error;
    }
    return await publishTemporaryFile(args, temporaryPath, effect);
  } finally {
    await cleanup().catch(() => undefined);
  }
}
