import fs from "node:fs/promises";
import path from "node:path";
import {
  threadTransferRelativePathSchema,
  type HostDaemonOnlineRpcResult,
  type ThreadTransferFile,
} from "@bb/host-daemon-contract";
import { runGit } from "bb-environment-provider-host/workspace-git";
import { z } from "zod";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import {
  appendJsonLine,
  assertNoSymlinkBelow,
  fsyncPath,
  invalid,
  pathKind,
  placeNoReplace,
  readJsonLines,
  resolveRegularFile,
  verifyStagedFile,
  type ProviderFile,
  type TransferPaths,
} from "./thread-transfer-fs.js";

export const WORKSPACE_PREFIX = "workspace/";
const BUNDLE_PATH = "workspace/commits.bundle";
const PATCH_PATH = "workspace/changes.patch";
const META_PATH = "workspace/meta.json";
const UNTRACKED_PREFIX = "workspace/untracked/";
const GENERATED_DIRECTORY_NAME = "workspace-generated";
const PATCH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const GIT_HARDENING_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotePath=false",
];
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

const metaSchema = z
  .object({
    version: z.literal(1),
    sourceHead: z.string().min(1),
    targetHead: z.string().min(1),
    bundle: z.boolean(),
    patch: z.boolean(),
  })
  .strict();

const journalEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("plan"), cwd: z.string(), oldHead: z.string() }),
  z.object({ t: z.literal("mkdir"), path: z.string() }),
  z.object({ t: z.literal("patchStarted") }),
  z.object({
    t: z.literal("created"),
    path: z.string(),
    ino: z.number(),
  }),
  z.object({ t: z.literal("patchRecorded") }),
  z.object({ t: z.literal("applied") }),
]);

interface Git {
  (
    args: string[],
    allowFailure?: boolean,
    maxBufferBytes?: number,
  ): Promise<{ stdout: string; exitCode: number }>;
}

function gitIn(cwd: string): Git {
  return async (args, allowFailure = false, maxBufferBytes) => {
    const result = await runGit([...GIT_HARDENING_ARGS, ...args], {
      cwd,
      env: GIT_ENV,
      allowFailure,
      ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
    });
    return { stdout: result.stdout, exitCode: result.exitCode };
  };
}

async function readHead(git: Git): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "HEAD^{commit}"], true);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function isCheckoutRoot(git: Git, cwd: string): Promise<boolean> {
  const result = await git(["rev-parse", "--show-toplevel"], true).catch(
    () => null,
  );
  if (result === null || result.exitCode !== 0) {
    return false;
  }
  const [top, here] = await Promise.all([
    fs.realpath(result.stdout.trim()),
    fs.realpath(cwd),
  ]);
  return top === here;
}

async function isClean(git: Git): Promise<boolean> {
  const status = await git([
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  return status.stdout.length === 0;
}

async function isAncestor(git: Git, commit: string): Promise<boolean> {
  const result = await git(
    ["merge-base", "--is-ancestor", commit, "HEAD"],
    true,
  );
  return result.exitCode === 0;
}

export async function inspectThreadTransferWorkspace(
  command: CommandOf<"thread.transfer.inspect_workspace">,
): Promise<HostDaemonOnlineRpcResult<"thread.transfer.inspect_workspace">> {
  const git = gitIn(command.cwd);
  if (
    !(await fs.stat(command.cwd).then(
      (stats) => stats.isDirectory(),
      () => false,
    )) ||
    !(await isCheckoutRoot(git, command.cwd))
  ) {
    return { head: null, clean: false, containsAncestorCommit: false };
  }
  const head = await readHead(git);
  if (head === null) {
    return { head: null, clean: false, containsAncestorCommit: false };
  }
  return {
    head,
    clean: await isClean(git),
    containsAncestorCommit:
      command.ancestorCommit !== null &&
      (await isAncestor(git, command.ancestorCommit)),
  };
}

function isCarriedPath(relativePath: string): boolean {
  return relativePath.split("/").every((part) => {
    const lower = part.toLowerCase();
    return lower !== ".git" && lower !== ".env" && !lower.startsWith(".env.");
  });
}

export async function prepareWorkspaceExport(
  cwd: string,
  targetHead: string,
  paths: TransferPaths,
): Promise<{ files: ProviderFile[]; cleanup: () => Promise<void> }> {
  const git = gitIn(cwd);
  if (!(await isCheckoutRoot(git, cwd))) {
    throw invalid("Source workspace is not a git checkout");
  }
  const sourceHead = await readHead(git);
  if (sourceHead === null) {
    throw invalid("Source workspace has no commits");
  }
  if (!(await isAncestor(git, targetHead))) {
    throw invalid("Target branch is not behind the source; push or pull first");
  }
  const generated = path.join(paths.root, GENERATED_DIRECTORY_NAME);
  await fs.rm(generated, { recursive: true, force: true });
  await fs.mkdir(generated, { recursive: true, mode: 0o700 });
  const cleanup = () => fs.rm(generated, { recursive: true, force: true });
  try {
    const files: ProviderFile[] = [];
    const hasBundle = sourceHead !== targetHead;
    if (hasBundle) {
      const bundle = path.join(generated, "commits.bundle");
      await git(["bundle", "create", bundle, "HEAD", `^${targetHead}`]);
      files.push({ relativePath: BUNDLE_PATH, absolutePath: bundle });
    }
    const patch = path.join(generated, "changes.patch");
    await git(
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        `--output=${patch}`,
        "HEAD",
      ],
      false,
      PATCH_MAX_BUFFER_BYTES,
    );
    const hasPatch = (await fs.stat(patch)).size > 0;
    if (hasPatch) {
      files.push({ relativePath: PATCH_PATH, absolutePath: patch });
    }
    const listed = await git([
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ]);
    for (const relative of listed.stdout.split("\0").sort()) {
      if (
        relative.length === 0 ||
        relative.endsWith("/") ||
        !isCarriedPath(relative)
      ) {
        continue;
      }
      const transferPath = `${UNTRACKED_PREFIX}${relative}`;
      if (!threadTransferRelativePathSchema.safeParse(transferPath).success) {
        throw invalid(
          `Cannot carry untracked file with this name: ${relative}`,
        );
      }
      const absolutePath = path.join(cwd, relative);
      if (!(await fs.lstat(absolutePath)).isFile()) {
        throw invalid(`Refusing non-regular untracked file: ${relative}`);
      }
      files.push({ relativePath: transferPath, absolutePath });
    }
    const meta = path.join(generated, "meta.json");
    await fs.writeFile(
      meta,
      JSON.stringify({
        version: 1,
        sourceHead,
        targetHead,
        bundle: hasBundle,
        patch: hasPatch,
      } satisfies z.infer<typeof metaSchema>),
      { mode: 0o600 },
    );
    files.push({ relativePath: META_PATH, absolutePath: meta });
    return { files, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function isWorkspaceFile(file: ThreadTransferFile): boolean {
  return file.relativePath.startsWith(WORKSPACE_PREFIX);
}

async function readJournal(paths: TransferPaths) {
  const values = await readJsonLines(paths.workspaceJournal);
  return values === null
    ? null
    : values.map((value) => journalEventSchema.parse(value));
}

export async function hasWorkspaceJournal(
  paths: TransferPaths,
): Promise<boolean> {
  return (await pathKind(paths.workspaceJournal)) !== "missing";
}

async function listUntracked(git: Git): Promise<string[]> {
  const listed = await git([
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  return listed.stdout.split("\0").filter((entry) => entry.length > 0);
}

async function removeIfOurs(target: string, ino: number | null) {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (stats.isFile() && (ino === null || stats.ino === ino)) {
    await fs.unlink(target);
    await fsyncPath(path.dirname(target));
  }
}

export async function undoWorkspaceJournal(
  paths: TransferPaths,
): Promise<void> {
  const events = await readJournal(paths);
  if (events === null) {
    return;
  }
  const plan = events.find((event) => event.t === "plan");
  if (plan?.t === "plan") {
    const git = gitIn(plan.cwd);
    await git(["reset", "--hard", "--quiet", plan.oldHead]);
    const created = events.flatMap((event) =>
      event.t === "created" ? [event] : [],
    );
    if (
      events.some((event) => event.t === "patchStarted") &&
      !events.some((event) => event.t === "patchRecorded")
    ) {
      for (const relative of await listUntracked(git)) {
        await removeIfOurs(path.join(plan.cwd, relative), null);
      }
    }
    for (const entry of created.reverse()) {
      await removeIfOurs(entry.path, entry.ino);
      await removeEmptyParents(plan.cwd, path.dirname(entry.path), events);
    }
    for (const event of [...events].reverse()) {
      if (event.t === "mkdir") {
        await fs.rmdir(event.path).catch((error: unknown) => {
          if (
            !isFsErrorWithCode(error, "ENOENT") &&
            !isFsErrorWithCode(error, "ENOTEMPTY")
          ) {
            throw error;
          }
        });
      }
    }
  }
  await fs.rm(paths.workspaceJournal, { force: true });
  await fsyncPath(paths.root);
}

async function removeEmptyParents(
  cwd: string,
  directory: string,
  events: Array<z.infer<typeof journalEventSchema>>,
): Promise<void> {
  const journaled = new Set(
    events.flatMap((event) => (event.t === "mkdir" ? [event.path] : [])),
  );
  let current = directory;
  while (current !== cwd && current.startsWith(`${cwd}${path.sep}`)) {
    if (journaled.has(current)) {
      return;
    }
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

async function ensureJournaledDirectories(
  paths: TransferPaths,
  cwd: string,
  directory: string,
): Promise<void> {
  let current = cwd;
  for (const part of path.relative(cwd, directory).split(path.sep)) {
    if (part.length === 0) {
      continue;
    }
    current = path.join(current, part);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw invalid(`Refusing symbolic link or non-directory: ${current}`);
      }
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) {
        throw error;
      }
      await appendJsonLine(paths.workspaceJournal, {
        t: "mkdir",
        path: current,
      });
      await fs.mkdir(current);
      await fsyncPath(path.dirname(current));
    }
  }
}

async function readMeta(paths: TransferPaths) {
  const metaPath = await resolveRegularFile(paths.in, META_PATH);
  return metaSchema.parse(JSON.parse(await fs.readFile(metaPath, "utf8")));
}

export async function applyWorkspaceChanges(
  command: CommandOf<"thread.transfer.commit">,
  paths: TransferPaths,
): Promise<void> {
  const workspaceFiles = command.files.filter(isWorkspaceFile);
  if (command.workspace === undefined) {
    if (workspaceFiles.length > 0) {
      throw invalid("Workspace files were sent without a workspace request");
    }
    return;
  }
  const { targetHead } = command.workspace;
  for (const file of workspaceFiles) {
    await verifyStagedFile(paths, file);
  }
  if (!workspaceFiles.some((file) => file.relativePath === META_PATH)) {
    throw invalid("Workspace transfer is missing its metadata");
  }
  const cwd = path.resolve(command.cwd);
  const git = gitIn(cwd);
  if (!(await isCheckoutRoot(git, cwd))) {
    throw invalid("Target workspace is not a git checkout");
  }
  if (!(await isClean(git))) {
    throw invalid("Target workspace has uncommitted changes");
  }
  const oldHead = await readHead(git);
  if (oldHead !== targetHead) {
    throw invalid("Target workspace changed since the move started");
  }
  const meta = await readMeta(paths);
  if (meta.targetHead !== targetHead) {
    throw invalid("Workspace transfer was built for a different target commit");
  }
  const has = (relativePath: string) =>
    workspaceFiles.some((file) => file.relativePath === relativePath);
  if (meta.bundle !== has(BUNDLE_PATH) || meta.patch !== has(PATCH_PATH)) {
    throw invalid("Workspace transfer does not match its metadata");
  }

  await appendJsonLine(paths.workspaceJournal, { t: "plan", cwd, oldHead });
  await fsyncPath(paths.root);

  if (meta.bundle) {
    const bundle = await resolveRegularFile(paths.in, BUNDLE_PATH);
    const unbundled = await git(["bundle", "unbundle", bundle]);
    if (!unbundled.stdout.includes(meta.sourceHead)) {
      throw invalid("Workspace bundle does not contain the source commit");
    }
    await git(["merge", "--ff-only", "--quiet", meta.sourceHead]);
  } else if (meta.sourceHead !== targetHead) {
    throw invalid("Workspace transfer is missing its commits");
  }

  if (meta.patch) {
    const patch = await resolveRegularFile(paths.in, PATCH_PATH);
    await git(["apply", "--check", "--whitespace=nowarn", patch]);
    await appendJsonLine(paths.workspaceJournal, { t: "patchStarted" });
    await git(["apply", "--whitespace=nowarn", patch]);
    for (const relative of await listUntracked(git)) {
      const absolute = path.join(cwd, relative);
      await appendJsonLine(paths.workspaceJournal, {
        t: "created",
        path: absolute,
        ino: (await fs.lstat(absolute)).ino,
      });
    }
    await appendJsonLine(paths.workspaceJournal, { t: "patchRecorded" });
  }

  for (const file of workspaceFiles) {
    if (!file.relativePath.startsWith(UNTRACKED_PREFIX)) {
      continue;
    }
    const relative = file.relativePath.slice(UNTRACKED_PREFIX.length);
    if (!isCarriedPath(relative)) {
      throw invalid(`Refusing to write ${relative}`);
    }
    const destination = path.resolve(cwd, relative);
    if (!destination.startsWith(`${cwd}${path.sep}`)) {
      throw invalid("Untracked file escapes the workspace");
    }
    await assertNoSymlinkBelow(cwd, destination);
    await ensureJournaledDirectories(paths, cwd, path.dirname(destination));
    const staged = await resolveRegularFile(paths.in, file.relativePath);
    try {
      await placeNoReplace(staged, destination);
    } catch (error) {
      if (isFsErrorWithCode(error, "EEXIST")) {
        throw invalid(
          `Unexpected file appeared at ${destination}; refusing to overwrite it`,
        );
      }
      throw error;
    }
    await fs.chmod(destination, file.mode);
    await fsyncPath(destination);
    await appendJsonLine(paths.workspaceJournal, {
      t: "created",
      path: destination,
      ino: (await fs.lstat(destination)).ino,
    });
  }
  await appendJsonLine(paths.workspaceJournal, { t: "applied" });
}
