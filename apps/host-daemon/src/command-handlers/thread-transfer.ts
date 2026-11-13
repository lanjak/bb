import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { hashFile } from "@bb/file-transfer";
import {
  THREAD_TRANSFER_MAX_FILES,
  THREAD_TRANSFER_MAX_TOTAL_BYTES,
  threadTransferRelativePathSchema,
  type HostDaemonBridgeLaunch,
  type HostDaemonOnlineRpcResult,
  type ThreadTransferFile,
  type ThreadTransferSessionEnvironment,
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
  setAsideJournal: string;
  sealed: string;
  setAside: string;
}

interface SessionRef {
  threadId: string;
  providerId: string;
  providerThreadId: string;
  cwd: string;
}

interface ProviderFile {
  relativePath: string;
  absolutePath: string;
}

const journalEntrySchema = z.object({
  destinationPath: z.string(),
  stagedPath: z.string(),
  backupPath: z.string().nullable(),
});

const journalEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("plan"), entries: z.array(journalEntrySchema) }),
  z.object({ t: z.literal("backedUp"), i: z.number().int().nonnegative() }),
  z.object({
    t: z.literal("placed"),
    i: z.number().int().nonnegative(),
    ino: z.number(),
  }),
  z.object({ t: z.literal("committed") }),
]);
type JournalEvent = z.infer<typeof journalEventSchema>;

interface JournalState {
  entries: Array<z.infer<typeof journalEntrySchema>>;
  placed: Map<number, number>;
  committed: boolean;
}

const setAsideEventSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("plan"),
    moves: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  z.object({ t: z.literal("done"), i: z.number().int().nonnegative() }),
]);

interface StagingStats {
  paths: Set<string>;
  bytes: number;
}

const transferLocks = new Map<string, Promise<unknown>>();
const stagingStats = new Map<string, StagingStats>();

async function withTransferLock<T>(
  transferId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = transferLocks.get(transferId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  transferLocks.set(transferId, run);
  try {
    return await run;
  } finally {
    if (transferLocks.get(transferId) === run) {
      transferLocks.delete(transferId);
    }
  }
}

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
    journal: path.join(root, "commit-journal.jsonl"),
    setAsideJournal: path.join(root, "set-aside-journal.jsonl"),
    sealed: path.join(root, "sealed"),
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

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  const handle = await fs.open(file, "a", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonLines(file: string): Promise<unknown[] | null> {
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

async function readJournal(paths: TransferPaths): Promise<JournalState | null> {
  const values = await readJsonLines(paths.journal);
  if (values === null) {
    return null;
  }
  const state: JournalState = {
    entries: [],
    placed: new Map(),
    committed: false,
  };
  for (const value of values) {
    const event = journalEventSchema.parse(value);
    if (event.t === "plan") {
      state.entries = event.entries;
    } else if (event.t === "placed") {
      state.placed.set(event.i, event.ino);
    } else if (event.t === "committed") {
      state.committed = true;
    }
  }
  return state;
}

async function copyExclusive(
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

async function placeNoReplace(
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

async function removeRoot(paths: TransferPaths): Promise<void> {
  await fs.rm(paths.root, { recursive: true, force: true });
  await fsyncPath(path.dirname(paths.root));
  stagingStats.delete(path.basename(paths.root));
}

async function listRegularFiles(
  base: string,
  prefix: string,
  baseOptional: boolean,
): Promise<ProviderFile[]> {
  const found: ProviderFile[] = [];
  async function walk(directory: string, relativeDirectory: string) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        baseOptional &&
        directory === base &&
        isFsErrorWithCode(error, "ENOENT")
      ) {
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

interface ProviderCall extends SessionRef {
  bridgeLaunch: HostDaemonBridgeLaunch;
  sessionEnvironment: ThreadTransferSessionEnvironment;
}

async function providerArgs(command: ProviderCall, options: TransferOptions) {
  return {
    providerId: command.providerId,
    bridgeLaunch: await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    ),
    providerThreadId: command.providerThreadId,
    cwd: command.cwd,
    threadId: command.threadId,
    sessionEnvironment: command.sessionEnvironment,
  };
}

async function listProviderSessionFiles(
  command: ProviderCall,
  options: TransferOptions,
): Promise<ProviderFile[]> {
  const result = await options.listSessionFiles(
    await providerArgs(command, options),
  );
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
): Promise<number> {
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

export function exportThreadTransfer(
  command: CommandOf<"thread.transfer.export">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.export">> {
  return withTransferLock(command.transferId, async () => {
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
      true,
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
    let totalBytes = 0;
    for (const file of all) {
      const destination = resolveWithin(
        paths.out,
        relativeParts(file.relativePath),
      );
      const mode = await snapshotFile(file.absolutePath, destination);
      const hashed = await hashFile(destination);
      totalBytes += hashed.sizeBytes;
      if (totalBytes > THREAD_TRANSFER_MAX_TOTAL_BYTES) {
        await fs.rm(paths.out, { recursive: true, force: true });
        throw invalid(
          `Files to move exceed ${THREAD_TRANSFER_MAX_TOTAL_BYTES} bytes`,
        );
      }
      files.push({
        relativePath: file.relativePath,
        sizeBytes: hashed.sizeBytes,
        sha256: hashed.sha256,
        mode,
      });
    }
    return { files };
  });
}

export function readThreadTransferChunk(
  command: CommandOf<"thread.transfer.read_chunk">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.read_chunk">> {
  return withTransferLock(command.transferId, async () => {
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
  });
}

async function loadStagingStats(
  transferId: string,
  paths: TransferPaths,
): Promise<StagingStats> {
  const cached = stagingStats.get(transferId);
  if (cached !== undefined) {
    return cached;
  }
  const stats: StagingStats = { paths: new Set(), bytes: 0 };
  for (const file of await listRegularFiles(paths.in, "", true)) {
    stats.paths.add(file.relativePath);
    stats.bytes += (await fs.lstat(file.absolutePath)).size;
  }
  stagingStats.set(transferId, stats);
  return stats;
}

export function writeThreadTransferChunk(
  command: CommandOf<"thread.transfer.write_chunk">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.write_chunk">> {
  return withTransferLock(command.transferId, async () => {
    const content = Buffer.from(command.contentBase64, "base64");
    if (content.toString("base64") !== command.contentBase64) {
      throw invalid("Chunk is not canonical base64");
    }
    const paths = transferPaths(options.dataDir, command.transferId);
    if ((await pathKind(paths.sealed)) !== "missing") {
      throw invalid("Transfer is sealed: commit has started");
    }
    const parts = relativeParts(command.relativePath);
    const target = resolveWithin(paths.in, parts);
    await ensureTransferRoot(options.dataDir, paths);
    await ensurePrivateDirectory(paths.in);
    await assertNoSymlinkBelow(paths.in, path.dirname(target));
    const stats = await loadStagingStats(command.transferId, paths);
    const kind = await pathKind(target);
    if (kind === "other") {
      throw invalid(`Not a regular file: ${command.relativePath}`);
    }
    const currentSize = kind === "file" ? (await fs.lstat(target)).size : 0;
    if (command.offset > currentSize) {
      throw invalid(
        `Chunk offset ${command.offset} leaves a gap after ${currentSize} bytes`,
      );
    }
    const newSize = Math.max(currentSize, command.offset + content.byteLength);
    const key = parts.join("/");
    const projectedFiles = stats.paths.size + (stats.paths.has(key) ? 0 : 1);
    const projectedBytes = stats.bytes + (newSize - currentSize);
    if (
      projectedFiles > THREAD_TRANSFER_MAX_FILES ||
      projectedBytes > THREAD_TRANSFER_MAX_TOTAL_BYTES
    ) {
      throw invalid("Staged transfer exceeds file count or size limits");
    }
    await ensurePrivateDirectory(path.dirname(target));
    const handle = await fs.open(
      target,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      if (content.byteLength > 0) {
        await handle.write(content, 0, content.byteLength, command.offset);
      }
      await handle.sync();
    } catch (error) {
      stagingStats.delete(command.transferId);
      throw error;
    } finally {
      await handle.close();
    }
    stats.paths.add(key);
    stats.bytes = projectedBytes;
    return { sizeBytes: newSize };
  });
}

async function verifyStagedFile(
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

async function isOurs(
  entry: z.infer<typeof journalEntrySchema>,
  placedIno: number | undefined,
): Promise<boolean> {
  let destination;
  try {
    destination = await fs.lstat(entry.destinationPath);
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (!destination.isFile()) {
    return false;
  }
  if (placedIno !== undefined && destination.ino === placedIno) {
    return true;
  }
  try {
    return (await fs.lstat(entry.stagedPath)).ino === destination.ino;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function undoJournal(
  paths: TransferPaths,
  state: JournalState,
): Promise<void> {
  for (const [index, entry] of [...state.entries.entries()].reverse()) {
    if (await isOurs(entry, state.placed.get(index))) {
      await fs.unlink(entry.destinationPath);
      await fsyncPath(path.dirname(entry.destinationPath));
    }
    if (
      entry.backupPath !== null &&
      (await pathKind(entry.backupPath)) === "file"
    ) {
      if ((await pathKind(entry.destinationPath)) !== "missing") {
        throw invalid(
          `Cannot restore ${entry.destinationPath}: an unexpected file is present`,
        );
      }
      await placeNoReplace(entry.backupPath, entry.destinationPath);
    }
  }
  await fs.rm(paths.journal, { force: true });
  await fsyncPath(paths.root);
}

async function ensureRealDirectories(
  logicalRoot: string,
  directory: string,
): Promise<void> {
  let current = logicalRoot;
  for (const part of path.relative(logicalRoot, directory).split(path.sep)) {
    if (part.length === 0) {
      continue;
    }
    current = path.join(current, part);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) {
        throw error;
      }
      await fs.mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
      await fsyncPath(path.dirname(current));
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw invalid(`Refusing symbolic link or non-directory: ${current}`);
    }
  }
}

interface TrustedRoot {
  logical: string;
  real: string;
}

async function trustRoot(logicalRoot: string): Promise<TrustedRoot> {
  const logical = path.resolve(logicalRoot);
  await fs.mkdir(logical, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return { logical, real: await fs.realpath(logical) };
}

async function prepareParent(
  root: TrustedRoot,
  destinationPath: string,
): Promise<void> {
  const parent = path.dirname(destinationPath);
  await ensureRealDirectories(root.logical, parent);
  const expected = path.join(root.real, path.relative(root.logical, parent));
  if ((await fs.realpath(parent)) !== expected) {
    throw invalid(`Destination parent moved or is a symbolic link: ${parent}`);
  }
}

export function commitThreadTransfer(
  command: CommandOf<"thread.transfer.commit">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.commit">> {
  return withTransferLock(command.transferId, async () => {
    const paths = transferPaths(options.dataDir, command.transferId);
    const existing = await readJournal(paths);
    if (existing?.committed === true) {
      return {
        placedFiles: existing.entries.length,
        backedUpFiles: existing.entries.filter(
          (entry) => entry.backupPath !== null,
        ).length,
      };
    }
    if (existing !== null) {
      await undoJournal(paths, existing);
    }
    if (command.files.length > THREAD_TRANSFER_MAX_FILES) {
      throw invalid(`Too many files to move: ${command.files.length}`);
    }
    if (
      command.files.reduce((sum, file) => sum + file.sizeBytes, 0) >
      THREAD_TRANSFER_MAX_TOTAL_BYTES
    ) {
      throw invalid("Files to move exceed the transfer size limit");
    }
    if (
      new Set(command.files.map((file) => file.relativePath)).size !==
      command.files.length
    ) {
      throw invalid("Duplicate transfer paths");
    }
    await ensureTransferRoot(options.dataDir, paths);
    await fs.writeFile(paths.sealed, "", {
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
    await fsyncPath(paths.root);
    stagingStats.delete(command.transferId);
    try {
      return await placeStagedFiles(command, options, paths);
    } catch (error) {
      const state = await readJournal(paths).catch(() => null);
      let undone = state === null;
      if (state !== null) {
        undone = await undoJournal(paths, state).then(
          () => true,
          (undoError: unknown) => {
            options.logger.warn(
              `thread transfer undo failed: ${undoError instanceof Error ? undoError.message : String(undoError)}`,
            );
            return false;
          },
        );
      }
      if (undone) {
        await fs.rm(paths.sealed, { force: true });
      }
      throw error;
    }
  });
}

async function placeStagedFiles(
  command: CommandOf<"thread.transfer.commit">,
  options: TransferOptions,
  paths: TransferPaths,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.commit">> {
  for (const file of command.files) {
    await verifyStagedFile(paths, file);
  }
  const destination = await options.resolveSessionDestination(
    await providerArgs(command, options),
  );
  if (
    !path.isAbsolute(destination.directory) ||
    !path.isAbsolute(destination.root)
  ) {
    throw invalid("Provider destination must be an absolute path");
  }
  const sessionRoot = await trustRoot(destination.root);
  const sessionDirectory = path.resolve(destination.directory);
  const relativeSession = path.relative(sessionRoot.logical, sessionDirectory);
  if (relativeSession.startsWith("..") || path.isAbsolute(relativeSession)) {
    throw invalid("Provider destination is outside its root");
  }
  const storageRoot = await trustRoot(options.threadStorageRootPath);
  const storageDirectory = path.resolve(
    threadStorageDirectory(options, command.threadId),
  );

  const plan: Array<{
    file: ThreadTransferFile;
    root: TrustedRoot;
    destinationPath: string;
    stagedPath: string;
    backupPath: string | null;
  }> = [];
  for (const [index, file] of command.files.entries()) {
    const [area, ...rest] = relativeParts(file.relativePath);
    const isSession = area === "session";
    const root = isSession ? sessionRoot : storageRoot;
    const destinationPath = resolveWithin(
      isSession ? sessionDirectory : storageDirectory,
      rest,
    );
    await assertNoSymlinkBelow(root.logical, destinationPath);
    const kind = await pathKind(destinationPath);
    if (kind === "other") {
      throw invalid(`Destination is not a regular file: ${destinationPath}`);
    }
    plan.push({
      file,
      root,
      destinationPath,
      stagedPath: resolveWithin(paths.in, relativeParts(file.relativePath)),
      backupPath:
        kind === "file"
          ? path.join(
              paths.backup,
              `${index}-${path.basename(destinationPath)}`,
            )
          : null,
    });
  }

  await ensurePrivateDirectory(paths.backup);
  await appendJsonLine(paths.journal, {
    t: "plan",
    entries: plan.map((item) => ({
      destinationPath: item.destinationPath,
      stagedPath: item.stagedPath,
      backupPath: item.backupPath,
    })),
  } satisfies JournalEvent);
  await fsyncPath(paths.root);

  for (const [index, item] of plan.entries()) {
    await verifyStagedFile(paths, item.file);
    await prepareParent(item.root, item.destinationPath);
    if (item.backupPath !== null) {
      await placeNoReplace(item.destinationPath, item.backupPath);
      await appendJsonLine(paths.journal, {
        t: "backedUp",
        i: index,
      } satisfies JournalEvent);
    }
    try {
      await placeNoReplace(item.stagedPath, item.destinationPath);
    } catch (error) {
      if (isFsErrorWithCode(error, "EEXIST")) {
        throw invalid(
          `Unexpected file appeared at ${item.destinationPath}; refusing to overwrite it`,
        );
      }
      throw error;
    }
    await fs.chmod(item.destinationPath, item.file.mode);
    await fsyncPath(item.destinationPath);
    await appendJsonLine(paths.journal, {
      t: "placed",
      i: index,
      ino: (await fs.lstat(item.destinationPath)).ino,
    } satisfies JournalEvent);
  }
  await appendJsonLine(paths.journal, {
    t: "committed",
  } satisfies JournalEvent);
  return {
    placedFiles: plan.length,
    backedUpFiles: plan.filter((item) => item.backupPath !== null).length,
  };
}

export function rollbackThreadTransfer(
  command: CommandOf<"thread.transfer.rollback">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.rollback">> {
  return withTransferLock(command.transferId, async () => {
    const paths = transferPaths(options.dataDir, command.transferId);
    const state = await readJournal(paths);
    if (state !== null) {
      await undoJournal(paths, state);
    }
    await removeRoot(paths);
    return { ok: true };
  });
}

async function removeEmptyDirectories(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  let empty = true;
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await removeEmptyDirectories(path.join(directory, entry.name)))
    ) {
      continue;
    }
    empty = false;
  }
  if (empty) {
    await fs.rmdir(directory);
    await fsyncPath(path.dirname(directory));
  }
  return empty;
}

interface SetAsideMove {
  from: string;
  to: string;
}

async function runSetAsideMove(move: SetAsideMove): Promise<void> {
  if ((await pathKind(move.from)) === "missing") {
    if ((await pathKind(move.to)) === "file") {
      return;
    }
    throw invalid(`Cannot set aside ${move.from}: file is missing`);
  }
  try {
    await placeNoReplace(move.from, move.to);
  } catch (error) {
    if (!isFsErrorWithCode(error, "EEXIST")) {
      throw error;
    }
    const [source, existing] = await Promise.all([
      hashFile(move.from),
      hashFile(move.to),
    ]);
    if (source.sha256 !== existing.sha256) {
      throw invalid(`Set-aside destination differs: ${move.to}`);
    }
    await fs.unlink(move.from);
    await fsyncPath(path.dirname(move.from));
  }
}

async function readSetAsideJournal(
  paths: TransferPaths,
): Promise<{ moves: SetAsideMove[]; done: Set<number> } | null> {
  const values = await readJsonLines(paths.setAsideJournal);
  if (values === null) {
    return null;
  }
  let moves: SetAsideMove[] | null = null;
  const done = new Set<number>();
  for (const value of values) {
    const event = setAsideEventSchema.parse(value);
    if (event.t === "plan") {
      moves = event.moves;
    } else {
      done.add(event.i);
    }
  }
  return moves === null ? null : { moves, done };
}

export function finishThreadTransfer(
  command: CommandOf<"thread.transfer.finish">,
  options: TransferOptions,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.finish">> {
  return withTransferLock(command.transferId, async () => {
    const paths = transferPaths(options.dataDir, command.transferId);
    let journal = await readSetAsideJournal(paths);
    if (journal === null) {
      const moves: SetAsideMove[] = [];
      if (command.setAsideSession !== null) {
        if (command.bridgeLaunch === null) {
          throw invalid("A bridge launch is required to set a session aside");
        }
        const files = await listProviderSessionFiles(
          {
            ...command.setAsideSession,
            bridgeLaunch: command.bridgeLaunch,
            sessionEnvironment: command.sessionEnvironment,
          },
          options,
        );
        for (const file of files) {
          moves.push({
            from: file.absolutePath,
            to: resolveWithin(paths.setAside, relativeParts(file.relativePath)),
          });
        }
      }
      if (command.setAsideSession !== null) {
        for (const file of await listRegularFiles(
          threadStorageDirectory(options, command.setAsideSession.threadId),
          "storage/",
          true,
        )) {
          moves.push({
            from: file.absolutePath,
            to: resolveWithin(paths.setAside, relativeParts(file.relativePath)),
          });
        }
      }
      for (const backup of await listRegularFiles(
        paths.backup,
        "backup/",
        true,
      )) {
        moves.push({
          from: backup.absolutePath,
          to: resolveWithin(paths.setAside, backup.relativePath.split("/")),
        });
      }
      if (moves.length > 0) {
        await ensureTransferRoot(options.dataDir, paths);
        await appendJsonLine(paths.setAsideJournal, { t: "plan", moves });
        await fsyncPath(paths.root);
      }
      journal = { moves, done: new Set() };
    }
    for (const [index, move] of journal.moves.entries()) {
      if (journal.done.has(index)) {
        continue;
      }
      await runSetAsideMove(move);
      await appendJsonLine(paths.setAsideJournal, { t: "done", i: index });
    }
    if (command.setAsideSession !== null) {
      await removeEmptyDirectories(
        threadStorageDirectory(options, command.setAsideSession.threadId),
      );
    }
    await removeRoot(paths);
    return { ok: true };
  });
}
