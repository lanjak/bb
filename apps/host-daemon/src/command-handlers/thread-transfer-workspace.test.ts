import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDaemonBridgeLaunch } from "@bb/host-daemon-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatchOptions } from "../command-dispatch-support.js";
import {
  commitThreadTransfer,
  exportThreadTransfer,
  inspectThreadTransferWorkspace,
  readThreadTransferChunk,
  rollbackThreadTransfer,
  writeThreadTransferChunk,
} from "./thread-transfer.js";

vi.mock("../command-dispatch-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../command-dispatch-support.js")>()),
  resolveRuntimeBridgeLaunch: async () => ({}),
}));

const bridgeLaunch = {} as HostDaemonBridgeLaunch;
const sessionEnvironment = {
  projectId: "proj_1",
  environmentId: "env_1",
  contributedEnv: [],
};

interface Side {
  dataDir: string;
  workspace: string;
  options: Pick<
    CommandDispatchOptions,
    | "dataDir"
    | "threadStorageRootPath"
    | "fetchPluginHostArtifact"
    | "logger"
    | "listSessionFiles"
    | "resolveSessionDestination"
  >;
}

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

async function makeSide(name: string, workspace: string): Promise<Side> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `bb-ws-${name}-`));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const sessionDir = path.join(root, "claude", "projects", "-proj");
  await fs.mkdir(path.join(dataDir, "thread-storage"), { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "s1.jsonl"), `${name}\n`);
  return {
    dataDir,
    workspace,
    options: {
      dataDir,
      threadStorageRootPath: path.join(dataDir, "thread-storage"),
      logger: { debug: () => undefined, warn: () => undefined },
      listSessionFiles: async () => ({
        files: [
          { path: path.join(sessionDir, "s1.jsonl"), relativePath: "s1.jsonl" },
        ],
      }),
      resolveSessionDestination: async () => ({
        directory: sessionDir,
        root: path.dirname(path.dirname(sessionDir)),
      }),
    } as Side["options"],
  };
}

async function makeWorkspaces(): Promise<{ source: Side; target: Side }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bb-ws-git-"));
  roots.push(base);
  const sourcePath = path.join(base, "source");
  await fs.mkdir(sourcePath);
  git(sourcePath, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(sourcePath, ".gitignore"), "*.log\nignored/\n");
  await fs.writeFile(path.join(sourcePath, "a.txt"), "one\n");
  await fs.writeFile(path.join(sourcePath, "b.txt"), "bee\n");
  git(sourcePath, "add", "-A");
  git(sourcePath, "commit", "-qm", "base");
  const targetPath = path.join(base, "target");
  git(base, "clone", "-q", sourcePath, targetPath);
  return {
    source: await makeSide("source", sourcePath),
    target: await makeSide("target", targetPath),
  };
}

async function dirty(source: Side): Promise<void> {
  const cwd = source.workspace;
  await fs.writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
  git(cwd, "commit", "-qam", "second");
  await fs.writeFile(path.join(cwd, "staged.txt"), "staged\n");
  git(cwd, "add", "staged.txt");
  await fs.writeFile(path.join(cwd, "b.txt"), "bee\nchanged\n");
  await fs.mkdir(path.join(cwd, "deep", "dir"), { recursive: true });
  await fs.writeFile(path.join(cwd, "deep", "dir", "new.sh"), "echo hi\n", {
    mode: 0o755,
  });
  await fs.writeFile(path.join(cwd, "untracked.txt"), "loose\n");
  await fs.writeFile(path.join(cwd, "debug.log"), "ignored\n");
  await fs.mkdir(path.join(cwd, "ignored"));
  await fs.writeFile(path.join(cwd, "ignored", "x"), "ignored\n");
  await fs.writeFile(path.join(cwd, ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(cwd, ".env.local"), "SECRET=2\n");
}

function exportWorkspace(source: Side, targetHead: string, transferId = "t1") {
  return exportThreadTransfer(
    {
      type: "thread.transfer.export",
      transferId,
      bridgeLaunch,
      sessionEnvironment,
      threadId: "thr_1",
      providerId: "claude-code",
      providerThreadId: "s1",
      cwd: source.workspace,
      workspace: { targetHead },
    },
    source.options,
  );
}

async function copyAll(
  source: Side,
  target: Side,
  files: Array<{ relativePath: string; sizeBytes: number }>,
  transferId = "t1",
): Promise<void> {
  for (const file of files) {
    const chunk = await readThreadTransferChunk(
      {
        type: "thread.transfer.read_chunk",
        transferId,
        relativePath: file.relativePath,
        offset: 0,
        length: Math.max(1, file.sizeBytes),
      },
      source.options,
    );
    await writeThreadTransferChunk(
      {
        type: "thread.transfer.write_chunk",
        transferId,
        relativePath: file.relativePath,
        offset: 0,
        contentBase64: chunk.contentBase64,
      },
      target.options,
    );
  }
}

function commit(
  target: Side,
  files: Awaited<ReturnType<typeof exportWorkspace>>["files"],
  targetHead: string,
  transferId = "t1",
) {
  return commitThreadTransfer(
    {
      type: "thread.transfer.commit",
      transferId,
      bridgeLaunch,
      sessionEnvironment,
      threadId: "thr_1",
      providerId: "claude-code",
      providerThreadId: "s1",
      cwd: target.workspace,
      files,
      workspace: { targetHead },
    },
    target.options,
  );
}

async function stage(source: Side, target: Side, targetHead: string) {
  const { files } = await exportWorkspace(source, targetHead);
  await copyAll(source, target, files);
  return files;
}

let source: Side;
let target: Side;
let targetHead: string;

beforeEach(async () => {
  ({ source, target } = await makeWorkspaces());
  targetHead = git(target.workspace, "rev-parse", "HEAD");
  await dirty(source);
});

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("thread transfer workspace", () => {
  it("exports commits, a patch and untracked files but never ignored or env files", async () => {
    const { files } = await exportWorkspace(source, targetHead);
    expect(
      files
        .map((file) => file.relativePath)
        .filter((name) => name.startsWith("workspace/"))
        .sort(),
    ).toEqual([
      "workspace/changes.patch",
      "workspace/commits.bundle",
      "workspace/meta.json",
      "workspace/untracked/deep/dir/new.sh",
      "workspace/untracked/untracked.txt",
    ]);
  });

  it("carries commits, staged and unstaged changes and untracked files", async () => {
    const sourceStatus = git(source.workspace, "status", "--porcelain");
    const sourceHead = git(source.workspace, "rev-parse", "HEAD");
    const files = await stage(source, target, targetHead);
    await commit(target, files, targetHead);

    const cwd = target.workspace;
    expect(git(cwd, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe(
      "one\ntwo\n",
    );
    expect(await fs.readFile(path.join(cwd, "b.txt"), "utf8")).toBe(
      "bee\nchanged\n",
    );
    expect(await fs.readFile(path.join(cwd, "staged.txt"), "utf8")).toBe(
      "staged\n",
    );
    expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe(
      "loose\n",
    );
    const script = await fs.stat(path.join(cwd, "deep", "dir", "new.sh"));
    expect(script.mode & 0o111).not.toBe(0);
    for (const missing of [".env", ".env.local", "debug.log", "ignored"]) {
      await expect(fs.stat(path.join(cwd, missing))).rejects.toThrow();
    }
    expect(git(source.workspace, "status", "--porcelain")).toBe(sourceStatus);
    expect(git(source.workspace, "rev-parse", "HEAD")).toBe(sourceHead);
  });

  it("sends no bundle when the target already has the source commits", async () => {
    git(target.workspace, "pull", "-q");
    const equalHead = git(target.workspace, "rev-parse", "HEAD");
    const files = await stage(source, target, equalHead);
    expect(files.some((file) => file.relativePath.endsWith(".bundle"))).toBe(
      false,
    );
    await commit(target, files, equalHead);
    expect(git(target.workspace, "rev-parse", "HEAD")).toBe(equalHead);
    expect(
      await fs.readFile(path.join(target.workspace, "b.txt"), "utf8"),
    ).toBe("bee\nchanged\n");
  });

  it("reports a dirty or diverged target and refuses to apply onto it", async () => {
    await expect(
      inspectThreadTransferWorkspace({
        type: "thread.transfer.inspect_workspace",
        cwd: target.workspace,
        ancestorCommit: null,
      }),
    ).resolves.toEqual({
      head: targetHead,
      clean: true,
      containsAncestorCommit: false,
    });
    const files = await stage(source, target, targetHead);
    await fs.writeFile(path.join(target.workspace, "a.txt"), "local edit\n");
    await expect(commit(target, files, targetHead)).rejects.toThrow(
      /uncommitted changes/,
    );
    expect(git(target.workspace, "rev-parse", "HEAD")).toBe(targetHead);
    expect(
      await fs.readFile(path.join(target.workspace, "a.txt"), "utf8"),
    ).toBe("local edit\n");
    await expect(
      inspectThreadTransferWorkspace({
        type: "thread.transfer.inspect_workspace",
        cwd: target.workspace,
        ancestorCommit: null,
      }),
    ).resolves.toMatchObject({ clean: false });
  });

  it("refuses to export when the target commit is not an ancestor", async () => {
    await fs.writeFile(path.join(target.workspace, "t.txt"), "target only\n");
    git(target.workspace, "add", "t.txt");
    git(target.workspace, "commit", "-qm", "diverge");
    const diverged = git(target.workspace, "rev-parse", "HEAD");
    await expect(
      inspectThreadTransferWorkspace({
        type: "thread.transfer.inspect_workspace",
        cwd: source.workspace,
        ancestorCommit: diverged,
      }),
    ).resolves.toMatchObject({ containsAncestorCommit: false });
    await expect(exportWorkspace(source, diverged)).rejects.toThrow(
      /not behind the source/,
    );
  });

  it("refuses to apply when the target moved since the move started", async () => {
    const files = await stage(source, target, targetHead);
    await fs.writeFile(path.join(target.workspace, "t.txt"), "target only\n");
    git(target.workspace, "add", "t.txt");
    git(target.workspace, "commit", "-qm", "moved");
    await expect(commit(target, files, targetHead)).rejects.toThrow(
      /changed since the move started/,
    );
  });

  it("restores the target exactly when the transfer is rolled back after commit", async () => {
    const files = await stage(source, target, targetHead);
    await commit(target, files, targetHead);
    await rollbackThreadTransfer(
      { type: "thread.transfer.rollback", transferId: "t1" },
      target.options,
    );
    const cwd = target.workspace;
    expect(git(cwd, "rev-parse", "HEAD")).toBe(targetHead);
    expect(git(cwd, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(cwd, "branch", "--show-current")).toBe("main");
    await expect(fs.stat(path.join(cwd, "deep"))).rejects.toThrow();
    await expect(fs.stat(path.join(cwd, "untracked.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(cwd, "staged.txt"))).rejects.toThrow();
  });

  it("rolls the target back when placing an untracked file fails", async () => {
    const files = await stage(source, target, targetHead);
    const cwd = target.workspace;
    await fs.appendFile(
      path.join(cwd, ".git", "info", "exclude"),
      "untracked.txt\n",
    );
    await fs.writeFile(path.join(cwd, "untracked.txt"), "keep me\n");
    await expect(commit(target, files, targetHead)).rejects.toThrow(
      /refusing to overwrite/,
    );
    expect(git(cwd, "rev-parse", "HEAD")).toBe(targetHead);
    expect(git(cwd, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe(
      "keep me\n",
    );
    await expect(fs.stat(path.join(cwd, "staged.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(cwd, "deep"))).rejects.toThrow();
    expect(git(cwd, "branch", "--show-current")).toBe("main");
  });
});
