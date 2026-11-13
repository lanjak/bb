import { randomBytes } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { hashFile } from "@bb/file-transfer";
import {
  THREAD_TRANSFER_MAX_FILES,
  threadTransferRelativePathSchema,
  type HostDaemonOnlineRpcResult,
  type ThreadTransferFile,
} from "@bb/host-daemon-contract";
import { z } from "zod";
import {
  CommandDispatchError,
  resolveRuntimeBridgeLaunch,
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";

const TRANSFER_DIRECTORY_NAME = "thread-transfer";
const SET_ASIDE_DIRECTORY_NAME = "set-aside";
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

type TransferOptions = Pick<
  CommandDispatchOptions,
  | "dataDir"
  | "threadStorageRootPath"
  | "fetchPluginHostArtifact"
  | "logger"
  | "listSessionFiles"
  | "resolveSessionDestination"
>;

interface TransferPaths {
  root: string;
  out: string;
  in: string;
  backup: string;
  journal: string;
  setAside: string;
}

interface SessionRef {
  threadId: string;
  providerId: string;
  providerThreadId: string;
  cwd: string;
}

const journalSchema = z.object({
  state: z.enum(["placing", "committed"]),
  placedFiles: z.number().int().nonnegative(),
  backedUpFiles: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      destinationPath: z.string(),
      backupPath: z.string().nullable(),
    }),
  ),
});
type Journal = z.infer<typeof journalSchema>;

function invalid(message: string): CommandDispatchError {
  return new CommandDispatchError("thread_transfer_invalid", message);
}

function transferPaths(dataDir: string, transferId: string): TransferPaths {
  if (transferId === SET_ASIDE_DIRECTORY_NAME) {
    throw invalid("Transfer id is reserved");
  }
  const base = path.join(dataDir, TRANSFER_DIRECTORY_NAME);
  const root = path.join(base, transferId);
  return {
    root,
    out: path.join(root, "out"),
    in: path.join(root, "in"),
    backup: path.join(root, "backup"),
    journal: path.join(root, "commit-journal.json"),
    setAside: path.join(base, SET_ASIDE_DIRECTORY_NAME, transferId),
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
}

async function ensureTransferRoot(
  dataDir: string,
  paths: TransferPaths,
): Promise<void> {
  const base = path.join(dataDir, TRANSFER_DIRECTORY_NAME);
  await ensurePrivateDirectory(base);
  await fs.chmod(base, PRIVATE_DIRECTORY_MODE);
  await ensurePrivateDirectory(paths.root);
  await fs.chmod(paths.root, PRIVATE_DIRECTORY_MODE);
}

function relativeParts(relativePath: string): string[] {
  const parsed = threadTransferRelativePathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw invalid(`Invalid transfer path: ${relativePath}`);
  }
  return parsed.data.split("/");
}

function resolveWithin(base: string, parts: readonly string[]): string {
  const resolved = path.resolve(base, ...parts);
  if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) {
    throw invalid("Path escapes its transfer folder");
  }
  return resolved;
}

async function assertNoSymlinkBelow(
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

async function resolveRegularFile(
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

async function fsyncPath(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJournal(
  paths: TransferPaths,
  journal: Journal,
): Promise<void> {
  const temporary = `${paths.journal}.tmp`;
  const handle = await fs.open(temporary, "w", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, paths.journal);
  await fsyncPath(paths.root);
}

async function readJournal(paths: TransferPaths): Promise<Journal | null> {
  let text: string;
  try {
    text = await fs.readFile(paths.journal, "utf8");
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  return journalSchema.parse(JSON.parse(text));
}

async function pathKind(target: string): Promise<"missing" | "file" | "other"> {
  try {
    return (await fs.lstat(target)).isFile() ? "file" : "other";
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }
}

async function moveFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    if (!isFsErrorWithCode(error, "EXDEV")) {
      throw error;
    }
  }
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
  await fsyncPath(temporary);
  await fs.rename(temporary, destination);
  await fs.unlink(source);
}

async function removeRoot(paths: TransferPaths): Promise<void> {
  await fs.rm(paths.root, { recursive: true, force: true });
}

async function listRegularFiles(
  base: string,
  prefix: string,
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const found: Array<{ relativePath: string; absolutePath: string }> = [];
  async function walk(directory: string, relativeDirectory: string) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFsErrorWithCode(error, "ENOENT") && directory === base) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = `${relativeDirectory}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolutePath, `${relativePath}/`);
      } else if (entry.isFile()) {
        found.push({ relativePath: `${prefix}${relativePath}`, absolutePath });
      } else {
        throw invalid(`Refusing non-regular file: ${absolutePath}`);
      }
    }
  }
  await walk(base, "");
  return found;
}

function threadStorageDirectory(
  options: TransferOptions,
  threadId: string,
): string {
  if (!SAFE_SEGMENT.test(threadId)) {
    throw invalid(`Invalid thread id: ${threadId}`);
  }
  return path.join(options.threadStorageRootPath, threadId);
}

async function resolveBridgeLaunch(
  command: {
    bridgeLaunch: CommandOf<"thread.transfer.export">["bridgeLaunch"];
  },
  options: TransferOptions,
) {
  return resolveRuntimeBridgeLaunch(command.bridgeLaunch, options);
}

async function listProviderSessionFiles(
  command: SessionRef & {
    bridgeLaunch: CommandOf<"thread.transfer.export">["bridgeLaunch"];
  },
  options: TransferOptions,
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const result = await options.listSessionFiles({
    providerId: command.providerId,
    bridgeLaunch: await resolveBridgeLaunch(command, options),
    providerThreadId: command.providerThreadId,
    cwd: command.cwd,
  });
  return result.files.map((file) => {
    if (!path.isAbsolute(file.path)) {
      throw invalid(`Provider returned a relative path: ${file.path}`);
    }
    relativeParts(`session/${file.relativePath}`);
    return {
      relativePath: `session/${file.relativePath}`,
      absolutePath: file.path,
    };
  });
}

async function snapshotFile(
  sourcePath: string,
  destinationPath: string,
): Promise<ThreadTransferFile["mode"]> {
  const source = await fs.open(
    sourcePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stats = await source.stat();
    if (!stats.isFile()) {
      throw invalid(`Not a regular file: ${sourcePath}`);
    }
    await fs.mkdir(path.dirname(destinationPath), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await pipeline(
      source.createReadStream({ autoClose: false }),
      createWriteStream(destinationPath, {
        flags: "wx",
        mode: PRIVATE_FILE_MODE,
      }),
    );
    return stats.mode & 0o777;
  } finally {
    await source.close();
  }
}

export async function exportThreadTransfer(
  command: CommandOf<"thread.transfer.export">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.export">> {
  const paths = transferPaths(options.dataDir, command.transferId);
  const sessionFiles = await listProviderSessionFiles(command, options);
  if (sessionFiles.length === 0) {
    throw invalid(
      `Provider session ${command.providerThreadId} has no files to move`,
    );
  }
  const storageFiles = await listRegularFiles(
    threadStorageDirectory(options, command.threadId),
    "storage/",
  );
  const all = [...sessionFiles, ...storageFiles];
  if (all.length > THREAD_TRANSFER_MAX_FILES) {
    throw invalid(`Too many files to move: ${all.length}`);
  }
  if (new Set(all.map((file) => file.relativePath)).size !== all.length) {
    throw invalid("Duplicate transfer paths");
  }
  await ensureTransferRoot(options.dataDir, paths);
  await fs.rm(paths.out, { recursive: true, force: true });
  await ensurePrivateDirectory(paths.out);
  const files: ThreadTransferFile[] = [];
  for (const file of all) {
    const destination = resolveWithin(
      paths.out,
      relativeParts(file.relativePath),
    );
    const mode = await snapshotFile(file.absolutePath, destination);
    const hashed = await hashFile(destination);
    files.push({
      relativePath: file.relativePath,
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256,
      mode,
    });
  }
  return { files };
}

export async function readThreadTransferChunk(
  command: CommandOf<"thread.transfer.read_chunk">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.read_chunk">> {
  const paths = transferPaths(options.dataDir, command.transferId);
  const target = await resolveRegularFile(paths.out, command.relativePath);
  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const buffer = Buffer.alloc(command.length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      command.length,
      command.offset,
    );
    return {
      offset: command.offset,
      contentBase64: buffer.subarray(0, bytesRead).toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

export async function writeThreadTransferChunk(
  command: CommandOf<"thread.transfer.write_chunk">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.write_chunk">> {
  const content = Buffer.from(command.contentBase64, "base64");
  if (content.toString("base64") !== command.contentBase64) {
    throw invalid("Chunk is not canonical base64");
  }
  const paths = transferPaths(options.dataDir, command.transferId);
  const target = resolveWithin(paths.in, relativeParts(command.relativePath));
  await ensureTransferRoot(options.dataDir, paths);
  await ensurePrivateDirectory(paths.in);
  await assertNoSymlinkBelow(paths.in, path.dirname(target));
  await ensurePrivateDirectory(path.dirname(target));
  const handle = await fs.open(
    target,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw invalid(`Not a regular file: ${command.relativePath}`);
    }
    if (command.offset > stats.size) {
      throw invalid(
        `Chunk offset ${command.offset} leaves a gap after ${stats.size} bytes`,
      );
    }
    if (content.byteLength > 0) {
      await handle.write(content, 0, content.byteLength, command.offset);
    }
    await handle.sync();
    return {
      sizeBytes: Math.max(stats.size, command.offset + content.byteLength),
    };
  } finally {
    await handle.close();
  }
}

async function verifyStagedFiles(
  paths: TransferPaths,
  files: readonly ThreadTransferFile[],
): Promise<void> {
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
    throw invalid("Duplicate transfer paths");
  }
  for (const file of files) {
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
}

async function undoJournal(
  paths: TransferPaths,
  journal: Journal,
): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    if (entry.backupPath === null) {
      if ((await pathKind(entry.destinationPath)) === "file") {
        await fs.unlink(entry.destinationPath);
      }
      continue;
    }
    if ((await pathKind(entry.backupPath)) !== "file") {
      continue;
    }
    if ((await pathKind(entry.destinationPath)) === "file") {
      await fs.unlink(entry.destinationPath);
    }
    await moveFile(entry.backupPath, entry.destinationPath);
  }
  await fs.rm(paths.journal, { force: true });
}

export async function commitThreadTransfer(
  command: CommandOf<"thread.transfer.commit">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.commit">> {
  const paths = transferPaths(options.dataDir, command.transferId);
  const existing = await readJournal(paths);
  if (existing?.state === "committed") {
    return {
      placedFiles: existing.placedFiles,
      backedUpFiles: existing.backedUpFiles,
    };
  }
  if (existing !== null) {
    await undoJournal(paths, existing);
  }
  await verifyStagedFiles(paths, command.files);
  const destinationDirectory = (
    await options.resolveSessionDestination({
      providerId: command.providerId,
      bridgeLaunch: await resolveBridgeLaunch(command, options),
      providerThreadId: command.providerThreadId,
      cwd: command.cwd,
    })
  ).directory;
  if (!path.isAbsolute(destinationDirectory)) {
    throw invalid("Provider destination must be an absolute path");
  }
  const storageDirectory = threadStorageDirectory(options, command.threadId);
  const plan: Array<{ file: ThreadTransferFile; destinationPath: string }> = [];
  for (const file of command.files) {
    const parts = relativeParts(file.relativePath);
    const [area, ...rest] = parts;
    const base = area === "session" ? destinationDirectory : storageDirectory;
    const destinationPath = resolveWithin(base, rest);
    await assertNoSymlinkBelow(base, destinationPath);
    if ((await pathKind(destinationPath)) === "other") {
      throw invalid(`Destination is not a regular file: ${destinationPath}`);
    }
    plan.push({ file, destinationPath });
  }
  const entries: Journal["entries"] = [];
  for (const [index, item] of plan.entries()) {
    const exists = (await pathKind(item.destinationPath)) === "file";
    entries.push({
      destinationPath: item.destinationPath,
      backupPath: exists
        ? path.join(
            paths.backup,
            `${index}-${path.basename(item.destinationPath)}`,
          )
        : null,
    });
  }
  const backedUpFiles = entries.filter(
    (entry) => entry.backupPath !== null,
  ).length;
  const journal: Journal = {
    state: "placing",
    placedFiles: plan.length,
    backedUpFiles,
    entries,
  };
  await ensureTransferRoot(options.dataDir, paths);
  await ensurePrivateDirectory(paths.backup);
  await writeJournal(paths, journal);
  try {
    for (const [index, item] of plan.entries()) {
      const entry = entries[index];
      if (entry === undefined) {
        throw invalid("Commit plan is inconsistent");
      }
      if (entry.backupPath !== null) {
        await moveFile(item.destinationPath, entry.backupPath);
      }
      const staged = await resolveRegularFile(paths.in, item.file.relativePath);
      await moveFile(staged, item.destinationPath);
      await fs.chmod(item.destinationPath, item.file.mode);
      await fsyncPath(item.destinationPath);
    }
    await writeJournal(paths, { ...journal, state: "committed" });
  } catch (error) {
    await undoJournal(paths, journal).catch((undoError: unknown) => {
      options.logger.warn(
        `thread transfer undo failed: ${undoError instanceof Error ? undoError.message : String(undoError)}`,
      );
    });
    throw error;
  }
  return { placedFiles: plan.length, backedUpFiles };
}

export async function rollbackThreadTransfer(
  command: CommandOf<"thread.transfer.rollback">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.rollback">> {
  const paths = transferPaths(options.dataDir, command.transferId);
  const journal = await readJournal(paths);
  if (journal !== null) {
    await undoJournal(paths, journal);
  }
  await removeRoot(paths);
  return { ok: true };
}

export async function finishThreadTransfer(
  command: CommandOf<"thread.transfer.finish">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.finish">> {
  const paths = transferPaths(options.dataDir, command.transferId);
  if (command.setAsideSession !== null) {
    if (command.bridgeLaunch === null) {
      throw invalid("A bridge launch is required to set a session aside");
    }
    const files = await listProviderSessionFiles(
      {
        ...command.setAsideSession,
        bridgeLaunch: command.bridgeLaunch,
      },
      options,
    );
    for (const file of files) {
      const destination = resolveWithin(
        paths.setAside,
        relativeParts(file.relativePath),
      );
      await moveFile(file.absolutePath, destination);
    }
  }
  if ((await pathKind(paths.backup)) === "other") {
    const backups = await listRegularFiles(paths.backup, "backup/");
    for (const backup of backups) {
      await moveFile(
        backup.absolutePath,
        resolveWithin(paths.setAside, backup.relativePath.split("/")),
      );
    }
  }
  await removeRoot(paths);
  return { ok: true };
}
