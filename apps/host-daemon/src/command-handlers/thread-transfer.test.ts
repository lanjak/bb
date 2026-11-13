import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDaemonBridgeLaunch } from "@bb/host-daemon-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatchOptions } from "../command-dispatch-support.js";
import {
  commitThreadTransfer,
  exportThreadTransfer,
  finishThreadTransfer,
  readThreadTransferChunk,
  rollbackThreadTransfer,
  writeThreadTransferChunk,
} from "./thread-transfer.js";

vi.mock("../command-dispatch-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../command-dispatch-support.js")>()),
  resolveRuntimeBridgeLaunch: async () => ({
    pluginId: "test",
    dataDir: "/tmp",
    source: { kind: "artifact", digest: "x", artifactPath: "/tmp/x" },
    capabilities: {
      providerInstallation: false,
      supportsServiceTier: false,
      permissionModes: ["accept-edits"],
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
    },
    providerOptions: {},
    envPassthrough: [],
  }),
}));

const bridgeLaunch: HostDaemonBridgeLaunch = {
  pluginId: "test",
  source: { kind: "artifact", digest: "a".repeat(64), byteLength: 1 },
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["accept-edits"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
  },
  providerOptions: {},
  envPassthrough: [],
};

interface Side {
  dataDir: string;
  sessionDir: string;
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

async function makeSide(name: string): Promise<Side> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `bb-transfer-${name}-`));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const sessionDir = path.join(root, "claude", "projects", "-proj");
  await fs.mkdir(path.join(dataDir, "thread-storage"), { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  return {
    dataDir,
    sessionDir,
    options: {
      dataDir,
      threadStorageRootPath: path.join(dataDir, "thread-storage"),
      logger: { debug: () => undefined, warn: () => undefined },
      listSessionFiles: async () => {
        const files: Array<{ path: string; relativePath: string }> = [];
        for (const name of ["s1.jsonl", "s1/subagents/a.jsonl"]) {
          const filePath = path.join(sessionDir, name);
          if (
            await fs.stat(filePath).then(
              () => true,
              () => false,
            )
          ) {
            files.push({ path: filePath, relativePath: name });
          }
        }
        return { files };
      },
      resolveSessionDestination: async () => ({
        directory: sessionDir,
        root: path.dirname(path.dirname(sessionDir)),
      }),
    },
  };
}

const session = {
  threadId: "thr_1",
  providerId: "claude-code",
  providerThreadId: "s1",
  cwd: "/proj",
};

async function seedSource(side: Side): Promise<void> {
  await fs.mkdir(path.join(side.sessionDir, "s1", "subagents"), {
    recursive: true,
  });
  await fs.writeFile(path.join(side.sessionDir, "s1.jsonl"), "transcript\n");
  await fs.writeFile(
    path.join(side.sessionDir, "s1", "subagents", "a.jsonl"),
    "sub\n",
  );
  const storage = path.join(side.options.threadStorageRootPath, "thr_1");
  await fs.mkdir(path.join(storage, "notes"), { recursive: true });
  await fs.writeFile(path.join(storage, "notes", "n.md"), "note\n");
}

async function exportFrom(source: Side, transferId = "t1") {
  return exportThreadTransfer(
    {
      type: "thread.transfer.export",
      transferId,
      bridgeLaunch,
      sessionEnvironment: {
        projectId: "proj_1",
        environmentId: "env_1",
        contributedEnv: [],
      },
      ...session,
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
    for (let offset = 0; offset < file.sizeBytes || offset === 0; offset += 4) {
      const chunk = await readThreadTransferChunk(
        {
          type: "thread.transfer.read_chunk",
          transferId,
          relativePath: file.relativePath,
          offset,
          length: 4,
        },
        source.options,
      );
      await writeThreadTransferChunk(
        {
          type: "thread.transfer.write_chunk",
          transferId,
          relativePath: file.relativePath,
          offset,
          contentBase64: chunk.contentBase64,
        },
        target.options,
      );
      if (file.sizeBytes === 0) break;
    }
  }
}

function commitCommand(
  files: Awaited<ReturnType<typeof exportFrom>>["files"],
  transferId = "t1",
) {
  return {
    type: "thread.transfer.commit" as const,
    transferId,
    bridgeLaunch,
    sessionEnvironment: {
      projectId: "proj_1",
      environmentId: "env_1",
      contributedEnv: [],
    },
    files,
    ...session,
  };
}

let source: Side;
let target: Side;

beforeEach(async () => {
  source = await makeSide("source");
  target = await makeSide("target");
  await seedSource(source);
});

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("thread transfer", () => {
  it("snapshots session and storage files into a private folder", async () => {
    const { files } = await exportFrom(source);
    expect(files.map((file) => file.relativePath).sort()).toEqual([
      "session/s1.jsonl",
      "session/s1/subagents/a.jsonl",
      "storage/notes/n.md",
    ]);
    const transcript = files.find(
      (file) => file.relativePath === "session/s1.jsonl",
    );
    expect(transcript?.sha256).toBe(
      createHash("sha256").update("transcript\n").digest("hex"),
    );
    const stats = await fs.stat(
      path.join(source.dataDir, "thread-transfer", "t1"),
    );
    expect(stats.mode & 0o777).toBe(0o700);
    await fs.writeFile(path.join(source.sessionDir, "s1.jsonl"), "changed\n");
    const chunk = await readThreadTransferChunk(
      {
        type: "thread.transfer.read_chunk",
        transferId: "t1",
        relativePath: "session/s1.jsonl",
        offset: 0,
        length: 1024,
      },
      source.options,
    );
    expect(Buffer.from(chunk.contentBase64, "base64").toString()).toBe(
      "transcript\n",
    );
  });

  it("fails export when the provider reports no session files", async () => {
    await fs.rm(path.join(source.sessionDir, "s1.jsonl"));
    await fs.rm(path.join(source.sessionDir, "s1"), { recursive: true });
    await expect(exportFrom(source)).rejects.toThrow(/no files to move/);
  });

  it("round-trips chunks and places verified files on the target", async () => {
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).resolves.toEqual({ placedFiles: 3, backedUpFiles: 0 });
    expect(
      await fs.readFile(path.join(target.sessionDir, "s1.jsonl"), "utf8"),
    ).toBe("transcript\n");
    expect(
      await fs.readFile(
        path.join(target.sessionDir, "s1", "subagents", "a.jsonl"),
        "utf8",
      ),
    ).toBe("sub\n");
    expect(
      await fs.readFile(
        path.join(
          target.options.threadStorageRootPath,
          "thr_1",
          "notes",
          "n.md",
        ),
        "utf8",
      ),
    ).toBe("note\n");
  });

  it("makes repeated chunk writes idempotent and rejects gaps", async () => {
    const write = (offset: number, text: string) =>
      writeThreadTransferChunk(
        {
          type: "thread.transfer.write_chunk",
          transferId: "t1",
          relativePath: "session/x",
          offset,
          contentBase64: Buffer.from(text).toString("base64"),
        },
        target.options,
      );
    await expect(write(0, "abcd")).resolves.toEqual({ sizeBytes: 4 });
    await expect(write(0, "abcd")).resolves.toEqual({ sizeBytes: 4 });
    await expect(write(4, "ef")).resolves.toEqual({ sizeBytes: 6 });
    await expect(write(10, "zz")).rejects.toThrow(/gap/);
  });

  it("refuses to place anything when a staged file fails sha256", async () => {
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    await fs.writeFile(
      path.join(
        target.dataDir,
        "thread-transfer",
        "t1",
        "in",
        "session",
        "s1.jsonl",
      ),
      "transcrIPT\n",
    );
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).rejects.toThrow(/sha256/);
    await expect(
      fs.stat(path.join(target.sessionDir, "s1.jsonl")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(target.options.threadStorageRootPath, "thr_1")),
    ).rejects.toThrow();
  });

  it("backs up existing files on commit and restores them on rollback", async () => {
    const existing = path.join(target.sessionDir, "s1.jsonl");
    await fs.writeFile(existing, "old target transcript\n");
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).resolves.toEqual({ placedFiles: 3, backedUpFiles: 1 });
    expect(await fs.readFile(existing, "utf8")).toBe("transcript\n");
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).resolves.toEqual({ placedFiles: 3, backedUpFiles: 1 });

    const rollback = {
      type: "thread.transfer.rollback" as const,
      transferId: "t1",
    };
    await expect(
      rollbackThreadTransfer(rollback, target.options),
    ).resolves.toEqual({
      ok: true,
    });
    expect(await fs.readFile(existing, "utf8")).toBe("old target transcript\n");
    await expect(
      fs.stat(path.join(target.sessionDir, "s1", "subagents", "a.jsonl")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(target.dataDir, "thread-transfer", "t1")),
    ).rejects.toThrow();
    await expect(
      rollbackThreadTransfer(rollback, target.options),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      rollbackThreadTransfer(rollback, source.options),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it("finishes by setting the source session aside and keeping target backups", async () => {
    const existing = path.join(target.sessionDir, "s1.jsonl");
    await fs.writeFile(existing, "old target transcript\n");
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    await commitThreadTransfer(commitCommand(files), target.options);

    const finishSource = {
      type: "thread.transfer.finish" as const,
      transferId: "t1",
      bridgeLaunch,
      sessionEnvironment: {
        projectId: "proj_1",
        environmentId: "env_1",
        contributedEnv: [],
      },
      setAsideSession: session,
    };
    await expect(
      finishThreadTransfer(finishSource, source.options),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      finishThreadTransfer(finishSource, source.options),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      fs.stat(path.join(source.sessionDir, "s1.jsonl")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(
          source.dataDir,
          "thread-transfer",
          "set-aside",
          "t1",
          "session",
          "s1.jsonl",
        ),
        "utf8",
      ),
    ).toBe("transcript\n");
    await expect(
      fs.stat(path.join(source.dataDir, "thread-transfer", "t1")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(
          source.dataDir,
          "thread-transfer",
          "set-aside",
          "t1",
          "storage",
          "notes",
          "n.md",
        ),
        "utf8",
      ),
    ).toBe("note\n");
    await expect(
      fs.stat(path.join(source.options.threadStorageRootPath, "thr_1")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(
          target.options.threadStorageRootPath,
          "thr_1",
          "notes",
          "n.md",
        ),
        "utf8",
      ),
    ).toBe("note\n");

    const finishTarget = {
      type: "thread.transfer.finish" as const,
      transferId: "t1",
      bridgeLaunch: null,
      sessionEnvironment: {
        projectId: "proj_1",
        environmentId: "env_1",
        contributedEnv: [],
      },
      setAsideSession: null,
    };
    await finishThreadTransfer(finishTarget, target.options);
    await finishThreadTransfer(finishTarget, target.options);
    expect(await fs.readFile(existing, "utf8")).toBe("transcript\n");
    const backups = await fs.readdir(
      path.join(target.dataDir, "thread-transfer", "set-aside", "t1", "backup"),
    );
    expect(backups).toHaveLength(1);
  });

  it("rejects path traversal and symlinks", async () => {
    await expect(
      readThreadTransferChunk(
        {
          type: "thread.transfer.read_chunk",
          transferId: "t1",
          relativePath: "session/../../x",
          offset: 0,
          length: 1,
        },
        source.options,
      ),
    ).rejects.toThrow(/Invalid transfer path/);
    await expect(exportFrom(source, "set-aside")).rejects.toThrow(/reserved/);

    const outside = path.join(source.dataDir, "secret.txt");
    await fs.writeFile(outside, "secret");
    await fs.symlink(
      outside,
      path.join(source.options.threadStorageRootPath, "thr_1", "link.txt"),
    );
    await expect(exportFrom(source)).rejects.toThrow(/non-regular/);
    await fs.rm(
      path.join(source.options.threadStorageRootPath, "thr_1", "link.txt"),
    );

    const { files } = await exportFrom(source);
    await fs.rm(
      path.join(
        source.dataDir,
        "thread-transfer",
        "t1",
        "out",
        "session",
        "s1.jsonl",
      ),
    );
    await fs.symlink(
      outside,
      path.join(
        source.dataDir,
        "thread-transfer",
        "t1",
        "out",
        "session",
        "s1.jsonl",
      ),
    );
    await expect(
      readThreadTransferChunk(
        {
          type: "thread.transfer.read_chunk",
          transferId: "t1",
          relativePath: "session/s1.jsonl",
          offset: 0,
          length: 10,
        },
        source.options,
      ),
    ).rejects.toThrow(/symbolic link/);

    await fs.mkdir(path.join(target.dataDir, "thread-transfer", "t2", "in"), {
      recursive: true,
    });
    await fs.symlink(
      target.dataDir,
      path.join(target.dataDir, "thread-transfer", "t2", "in", "session"),
    );
    await expect(
      writeThreadTransferChunk(
        {
          type: "thread.transfer.write_chunk",
          transferId: "t2",
          relativePath: "session/evil",
          offset: 0,
          contentBase64: "AA==",
        },
        target.options,
      ),
    ).rejects.toThrow(/symbolic link/);
    expect(files.length).toBe(3);
  });

  it("refuses to overwrite a destination that is a symlink", async () => {
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    const outside = path.join(target.dataDir, "outside.txt");
    await fs.writeFile(outside, "keep");
    await fs.symlink(outside, path.join(target.sessionDir, "s1.jsonl"));
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).rejects.toThrow(/symbolic link/);
    expect(await fs.readFile(outside, "utf8")).toBe("keep");
  });

  it("refuses a destination whose ancestor below the provider root is a symlink", async () => {
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    const outside = path.join(target.dataDir, "outside");
    await fs.mkdir(path.join(outside, "-proj"), { recursive: true });
    const projects = path.dirname(target.sessionDir);
    await fs.rm(projects, { recursive: true });
    await fs.symlink(outside, projects);
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(path.join(outside, "-proj"))).toEqual([]);
  });

  it("refuses to overwrite a file that appears after planning and keeps it on rollback", async () => {
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    const foreign = path.join(target.sessionDir, "s1.jsonl");
    const realpath = fs.realpath.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) {
        await fs.writeFile(foreign, "foreign\n");
      }
      return realpath(...args);
    });
    await expect(
      commitThreadTransfer(commitCommand(files), target.options),
    ).rejects.toThrow(/Unexpected file appeared|unexpected file/);
    spy.mockRestore();
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign\n");
    await expect(
      fs.stat(path.join(target.sessionDir, "s1", "subagents", "a.jsonl")),
    ).rejects.toThrow();
  });

  it("seals staging when commit starts so a racing or later write cannot change placed bytes", async () => {
    const { files } = await exportFrom(source);
    await copyAll(source, target, files);
    const write = (text: string) =>
      writeThreadTransferChunk(
        {
          type: "thread.transfer.write_chunk",
          transferId: "t1",
          relativePath: "session/s1.jsonl",
          offset: 0,
          contentBase64: Buffer.from(text).toString("base64"),
        },
        target.options,
      );
    const results = await Promise.allSettled([
      commitThreadTransfer(commitCommand(files), target.options),
      write("TRANSCRIPT\n"),
    ]);
    const placed = path.join(target.sessionDir, "s1.jsonl");
    const placedText = await fs.readFile(placed, "utf8").catch(() => null);
    expect(placedText === null || placedText === "transcript\n").toBe(true);
    if (results[0].status === "fulfilled") {
      expect(placedText).toBe("transcript\n");
    }
    await expect(write("late\n")).rejects.toThrow(/sealed|gap/);
  });

  it("enforces the staged file count limit during writes", async () => {
    const write = (name: string) =>
      writeThreadTransferChunk(
        {
          type: "thread.transfer.write_chunk",
          transferId: "t1",
          relativePath: `session/f${name}`,
          offset: 0,
          contentBase64: "",
        },
        target.options,
      );
    for (let start = 0; start < 10_000; start += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, i) => write(String(start + i))),
      );
    }
    await expect(write("extra")).rejects.toThrow(/exceeds/);
    await expect(write("5")).resolves.toEqual({ sizeBytes: 0 });
  }, 60_000);

  it("resumes set-aside after a failure partway through", async () => {
    const { files } = await exportFrom(source);
    const finish = {
      type: "thread.transfer.finish" as const,
      transferId: "t1",
      bridgeLaunch,
      sessionEnvironment: {
        projectId: "proj_1",
        environmentId: "env_1",
        contributedEnv: [],
      },
      setAsideSession: session,
    };
    const conflict = path.join(
      source.dataDir,
      "thread-transfer",
      "set-aside",
      "t1",
      "session",
      "s1",
      "subagents",
      "a.jsonl",
    );
    await fs.mkdir(path.dirname(conflict), { recursive: true });
    await fs.writeFile(conflict, "different");
    await expect(finishThreadTransfer(finish, source.options)).rejects.toThrow(
      /differs/,
    );
    await expect(
      fs.stat(path.join(source.sessionDir, "s1.jsonl")),
    ).rejects.toThrow();
    await fs.rm(conflict);
    await expect(finishThreadTransfer(finish, source.options)).resolves.toEqual(
      {
        ok: true,
      },
    );
    await expect(
      fs.stat(path.join(source.sessionDir, "s1", "subagents", "a.jsonl")),
    ).rejects.toThrow();
    expect(await fs.readFile(conflict, "utf8")).toBe("sub\n");
    expect(files.length).toBe(3);
  });

  it("resumes the thread storage set-aside and keeps the target storage", async () => {
    await exportFrom(source);
    const finish = {
      type: "thread.transfer.finish" as const,
      transferId: "t1",
      bridgeLaunch,
      sessionEnvironment: {
        projectId: "proj_1",
        environmentId: "env_1",
        contributedEnv: [],
      },
      setAsideSession: session,
    };
    const setAsideStorage = path.join(
      source.dataDir,
      "thread-transfer",
      "set-aside",
      "t1",
      "storage",
      "notes",
      "n.md",
    );
    await fs.mkdir(path.dirname(setAsideStorage), { recursive: true });
    await fs.writeFile(setAsideStorage, "different");
    const storageDirectory = path.join(
      source.options.threadStorageRootPath,
      "thr_1",
    );
    await expect(finishThreadTransfer(finish, source.options)).rejects.toThrow(
      /differs/,
    );
    expect(
      await fs.readFile(path.join(storageDirectory, "notes", "n.md"), "utf8"),
    ).toBe("note\n");
    await fs.rm(setAsideStorage);
    await expect(finishThreadTransfer(finish, source.options)).resolves.toEqual(
      { ok: true },
    );
    expect(await fs.readFile(setAsideStorage, "utf8")).toBe("note\n");
    await expect(fs.stat(storageDirectory)).rejects.toThrow();
  });

  it("leaves thread storage alone when no session is set aside", async () => {
    await exportFrom(source);
    await finishThreadTransfer(
      {
        type: "thread.transfer.finish",
        transferId: "t1",
        bridgeLaunch: null,
        sessionEnvironment: {
          projectId: "proj_1",
          environmentId: "env_1",
          contributedEnv: [],
        },
        setAsideSession: null,
      },
      source.options,
    );
    expect(
      await fs.readFile(
        path.join(
          source.options.threadStorageRootPath,
          "thr_1",
          "notes",
          "n.md",
        ),
        "utf8",
      ),
    ).toBe("note\n");
  });
});
