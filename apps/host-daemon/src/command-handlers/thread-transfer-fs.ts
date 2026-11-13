import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { hashFile } from "@bb/file-transfer";
import {
  threadTransferRelativePathSchema,
  type ThreadTransferFile,
} from "@bb/host-daemon-contract";
import { CommandDispatchError } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface TransferPaths {
  root: string;
  out: string;
  in: string;
  backup: string;
  journal: string;
  workspaceJournal: string;
  setAsideJournal: string;
  sealed: string;
  setAside: string;
}

export interface ProviderFile {
  relativePath: string;
  absolutePath: string;
}

export function invalid(message: string): CommandDispatchError {
  return new CommandDispatchError("thread_transfer_invalid", message);
}

export function relativeParts(relativePath: string): string[] {
  const parsed = threadTransferRelativePathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw invalid(`Invalid transfer path: ${relativePath}`);
  }
  return parsed.data.split("/");
}

export function resolveWithin(base: string, parts: readonly string[]): string {
  const resolved = path.resolve(base, ...parts);
  if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) {
    throw invalid("Path escapes its transfer folder");
  }
  return resolved;
}

export async function assertNoSymlinkBelow(
  base: string,
  target: string,
): Promise<void> {
  const parts = path.relative(base, target).split(path.sep);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw invalid(`Refusing symbolic link: ${current}`);
      }
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }
}

export async function resolveRegularFile(
  base: string,
  relativePath: string,
): Promise<string> {
  const target = resolveWithin(base, relativeParts(relativePath));
  await assertNoSymlinkBelow(base, target);
  const stats = await fs.lstat(target);
  if (!stats.isFile()) {
    throw invalid(`Not a regular file: ${relativePath}`);
  }
  return target;
}

export async function fsyncPath(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function pathKind(
  target: string,
): Promise<"missing" | "file" | "other"> {
  try {
    return (await fs.lstat(target)).isFile() ? "file" : "other";
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }
}

export async function appendJsonLine(
  file: string,
  value: unknown,
): Promise<void> {
  const handle = await fs.open(file, "a", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines(file: string): Promise<unknown[] | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const values: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1) {
        break;
      }
      throw error;
    }
  }
  return values;
}

export async function copyExclusive(
  source: string,
  destination: string,
): Promise<void> {
  const sourceHandle = await fs.open(
    source,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(destination, { flags: "wx", mode: PRIVATE_FILE_MODE }),
    );
  } finally {
    await sourceHandle.close();
  }
  await fsyncPath(destination);
}

export async function placeNoReplace(
  source: string,
  destination: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (
      !isFsErrorWithCode(error, "EXDEV") &&
      !isFsErrorWithCode(error, "EPERM") &&
      !isFsErrorWithCode(error, "ENOTSUP")
    ) {
      throw error;
    }
    await copyExclusive(source, destination);
  }
  await fsyncPath(path.dirname(destination));
  await fs.unlink(source);
  await fsyncPath(path.dirname(source));
}

export async function verifyStagedFile(
  paths: TransferPaths,
  file: ThreadTransferFile,
): Promise<void> {
  const staged = await resolveRegularFile(paths.in, file.relativePath);
  const hashed = await hashFile(staged);
  if (hashed.sizeBytes !== file.sizeBytes) {
    throw invalid(
      `Staged file ${file.relativePath} has ${hashed.sizeBytes} bytes; expected ${file.sizeBytes}`,
    );
  }
  if (hashed.sha256 !== file.sha256) {
    throw invalid(
      `Staged file ${file.relativePath} failed sha256 verification`,
    );
  }
}
