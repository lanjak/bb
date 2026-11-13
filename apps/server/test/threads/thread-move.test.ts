import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  archiveThread,
  createTerminalSession,
  createThreadMove,
  events,
  getThread,
  getThreadMove,
  getUnfinishedThreadMove,
  listCleanupPendingThreadMoves,
  threadMoves,
  updateThreadMovePhase,
} from "@bb/db";
import type { HostDaemonOnlineRpcRequestMessage } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import type { PluginThreadEventEmitter } from "../../src/services/plugins/plugin-service.js";
import { ApiError } from "../../src/errors.js";
import {
  moveThread,
  recoverThreadMoves,
} from "../../src/services/threads/thread-move.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { isThreadMoveInProgress } from "../../src/services/threads/thread-move-fence.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadIdentity,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

type Command = HostDaemonOnlineRpcRequestMessage["command"];

const PROVIDER_THREAD_ID = "claude-session-1";
const BIG_FILE = Buffer.alloc(1024 * 1024 + 123, "abc");
const SMALL_FILE = Buffer.from("{}\n");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface FakeDaemonOptions {
  failAfter?: number;
  failOn?: Command["type"];
  onCommit?: (command: Command) => void;
  shortWrite?: boolean;
}

class FakeDaemon {
  readonly commands: Command[] = [];
  private failOnSeen = 0;
  readonly staged = new Map<string, Buffer>();
  readonly source = new Map<string, Buffer>([
    ["session/abc.jsonl", BIG_FILE],
    ["session/abc/subagents/a.jsonl", SMALL_FILE],
    ["storage/empty.txt", Buffer.alloc(0)],
  ]);

  constructor(private readonly options: FakeDaemonOptions = {}) {}

  handle = (
    request: HostDaemonOnlineRpcRequestMessage,
  ): HostRpcHandlerResult => {
    const command = request.command;
    this.commands.push(command);
    if (
      command.type === this.options.failOn &&
      this.failOnSeen++ >= (this.options.failAfter ?? 0)
    ) {
      return {
        ok: false,
        errorCode: "test_failure",
        errorMessage: `${command.type} exploded`,
      };
    }
    switch (command.type) {
      case "thread.transfer.export":
        return {
          ok: true,
          result: {
            files: [...this.source].map(([relativePath, bytes]) => ({
              relativePath,
              sizeBytes: bytes.length,
              sha256: sha256(bytes),
              mode: 0o600,
            })),
          },
        };
      case "thread.transfer.read_chunk": {
        const bytes = this.source.get(command.relativePath)!;
        const chunk = bytes.subarray(
          command.offset,
          command.offset + command.length,
        );
        return {
          ok: true,
          result: {
            offset: command.offset,
            contentBase64: chunk.toString("base64"),
          },
        };
      }
      case "thread.transfer.write_chunk": {
        const current =
          this.staged.get(command.relativePath) ?? Buffer.alloc(0);
        const chunk = Buffer.from(command.contentBase64, "base64");
        const next = Buffer.concat([
          current.subarray(0, command.offset),
          chunk,
        ]);
        this.staged.set(command.relativePath, next);
        return {
          ok: true,
          result: {
            sizeBytes: this.options.shortWrite ? next.length - 1 : next.length,
          },
        };
      }
      case "thread.transfer.commit":
        this.options.onCommit?.(command);
        return { ok: true, result: { placedFiles: 3, backedUpFiles: 0 } };
      case "host.read_workspace_agent_context":
        return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
      case "thread.stop":
        return { ok: true, result: { providerCheckpointId: null } };
      case "thread.transfer.rollback":
      case "thread.transfer.finish":
        return { ok: true, result: { ok: true } };
      default:
        return {
          ok: false,
          errorCode: "unexpected",
          errorMessage: `Unexpected ${command.type}`,
        };
    }
  };

  types(): string[] {
    return this.commands.map((command) => command.type);
  }
}

interface Fixture {
  source: FakeDaemon;
  sourceEnvironmentId: string;
  sourceHostId: string;
  target: FakeDaemon;
  targetEnvironmentId: string;
  targetHostId: string;
  threadId: string;
  projectId: string;
}

function setup(
  harness: TestAppHarness,
  options: {
    source?: FakeDaemonOptions;
    target?: FakeDaemonOptions;
    providerId?: string;
  } = {},
): Fixture {
  const a = seedHostSession(harness.deps, { id: "host-a", name: "Alpha" });
  const b = seedHostSession(harness.deps, { id: "host-b", name: "Beta" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: a.host.id,
  });
  const sourceEnv = seedEnvironment(harness.deps, {
    hostId: a.host.id,
    projectId: project.id,
    path: "/work/a",
  });
  const targetEnv = seedEnvironment(harness.deps, {
    hostId: b.host.id,
    projectId: project.id,
    path: "/work/b",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: sourceEnv.id,
    providerId: options.providerId ?? "claude-code",
  });
  seedThreadIdentity(harness.deps, {
    threadId: thread.id,
    environmentId: sourceEnv.id,
    providerThreadId: PROVIDER_THREAD_ID,
  });
  const source = new FakeDaemon(options.source);
  const target = new FakeDaemon(options.target);
  registerHostRpcResponder(harness, {
    hostId: a.host.id,
    sessionId: a.session.id,
    handle: source.handle,
  });
  registerHostRpcResponder(harness, {
    hostId: b.host.id,
    sessionId: b.session.id,
    handle: target.handle,
  });
  return {
    source,
    sourceEnvironmentId: sourceEnv.id,
    sourceHostId: a.host.id,
    target,
    targetEnvironmentId: targetEnv.id,
    targetHostId: b.host.id,
    threadId: thread.id,
    projectId: project.id,
  };
}

function operationMessages(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select()
    .from(events)
    .where(eq(events.threadId, threadId))
    .all()
    .filter((row) => row.type === "system/operation")
    .map(
      (row) =>
        JSON.parse(row.data as string) as {
          operation: string;
          message: string;
        },
    );
}

function insertMove(harness: TestAppHarness, fx: Fixture) {
  return createThreadMove(harness.db, {
    id: "mv_test",
    groupId: "mvg_test",
    now: Date.now(),
    providerId: "claude-code",
    providerThreadId: PROVIDER_THREAD_ID,
    sourceCwd: "/work/a",
    sourceEnvironmentId: fx.sourceEnvironmentId,
    sourceHostId: fx.sourceHostId,
    targetCwd: "/work/b",
    targetEnvironmentId: fx.targetEnvironmentId,
    targetHostId: fx.targetHostId,
    threadId: fx.threadId,
  });
}

describe("thread move", () => {
  it("copies the session, switches the environment and appends the event", async () => {
    await withTestHarness(async (harness) => {
      const fx = setup(harness);
      const result = await moveThread(harness.deps, {
        threadId: fx.threadId,
        target: { environmentId: fx.targetEnvironmentId },
        withChildren: false,
      });

      expect(result).toMatchObject({
        phase: "done",
        error: null,
        sourceEnvironmentId: fx.sourceEnvironmentId,
        targetEnvironmentId: fx.targetEnvironmentId,
      });
      expect(getThread(harness.db, fx.threadId)?.environmentId).toBe(
        fx.targetEnvironmentId,
      );
      expect(fx.target.staged.get("session/abc.jsonl")).toEqual(BIG_FILE);
      expect(fx.target.staged.get("session/abc/subagents/a.jsonl")).toEqual(
        SMALL_FILE,
      );
      expect(fx.target.staged.get("storage/empty.txt")).toEqual(
        Buffer.alloc(0),
      );
      expect(fx.source.types()).toEqual([
        "thread.stop",
        "thread.transfer.export",
        "thread.transfer.read_chunk",
        "thread.transfer.read_chunk",
        "thread.transfer.read_chunk",
        "thread.transfer.finish",
      ]);
      expect(fx.target.types().at(-2)).toBe("thread.transfer.commit");
      expect(fx.target.commands.at(-1)).toMatchObject({
        type: "thread.transfer.finish",
        setAsideSession: null,
      });
      expect(fx.source.commands.at(-1)).toMatchObject({
        type: "thread.transfer.finish",
        setAsideSession: {
          threadId: fx.threadId,
          providerThreadId: PROVIDER_THREAD_ID,
          cwd: "/work/a",
        },
      });
      expect(operationMessages(harness, fx.threadId)).toEqual([
        expect.objectContaining({
          operation: "thread_move",
          message: "Moved from Alpha (/work/a) to Beta (/work/b)",
        }),
      ]);
      expect(getUnfinishedThreadMove(harness.db, fx.threadId)).toBeNull();
    });
  });

  it("never rolls back the target once the environment has switched", async () => {
    await withTestHarness(async (harness) => {
      const fx = setup(harness);
      const notifyThread = harness.deps.hub.notifyThread.bind(harness.deps.hub);
      harness.deps.hub.notifyThread = (threadId, changes, metadata) => {
        if (
          changes.includes("events-appended") &&
          getThread(harness.db, threadId)?.environmentId ===
            fx.targetEnvironmentId
        ) {
          throw new Error("notify failed after the switch");
        }
        return notifyThread(threadId, changes, metadata);
      };

      await expect(
        moveThread(harness.deps, {
          threadId: fx.threadId,
          target: { environmentId: fx.targetEnvironmentId },
          withChildren: false,
        }),
      ).rejects.toThrow("notify failed after the switch");

      expect(getThread(harness.db, fx.threadId)?.environmentId).toBe(
        fx.targetEnvironmentId,
      );
      expect(fx.target.types()).not.toContain("thread.transfer.rollback");
      expect(fx.source.types()).not.toContain("thread.transfer.rollback");
      expect(getUnfinishedThreadMove(harness.db, fx.threadId)?.phase).toBe(
        "switched",
      );
    });
  });

  describe("machine target", () => {
    function seedExtraEnvironment(
      harness: TestAppHarness,
      fx: Fixture,
      hostId: string,
      path: string,
    ) {
      return seedEnvironment(harness.deps, {
        hostId,
        projectId: fx.projectId,
        path,
      });
    }

    it("moves to the only reusable environment on the machine", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const result = await moveThread(harness.deps, {
          threadId: fx.threadId,
          target: { hostId: fx.targetHostId },
          withChildren: false,
        });
        expect(result.targetEnvironmentId).toBe(fx.targetEnvironmentId);
        expect(getThread(harness.db, fx.threadId)?.environmentId).toBe(
          fx.targetEnvironmentId,
        );
      });
    });

    it("prefers the environment whose path equals the source path", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const samePath = seedExtraEnvironment(
          harness,
          fx,
          fx.targetHostId,
          "/work/a",
        );
        seedExtraEnvironment(harness, fx, fx.targetHostId, "/work/c");
        const result = await moveThread(harness.deps, {
          threadId: fx.threadId,
          target: { hostId: fx.targetHostId },
          withChildren: false,
        });
        expect(result.targetEnvironmentId).toBe(samePath.id);
      });
    });

    it("refuses several environments without a path match and lists them", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const other = seedExtraEnvironment(
          harness,
          fx,
          fx.targetHostId,
          "/work/c",
        );
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { hostId: fx.targetHostId },
            withChildren: false,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: {
            code: "thread_move_refused",
            message: expect.stringContaining(
              `${fx.targetEnvironmentId}, ${other.id}`,
            ),
          },
        });
        expect(getUnfinishedThreadMove(harness.db, fx.threadId)).toBeNull();
        expect(fx.source.commands).toEqual([]);
      });
    });

    it("refuses a machine without a reusable environment and says how to add one", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const empty = seedHostSession(harness.deps, {
          id: "host-c",
          name: "Gamma",
        });
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { hostId: empty.host.id },
            withChildren: false,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: {
            code: "thread_move_refused",
            message: expect.stringContaining("bb project source add"),
          },
        });
      });
    });

    it("refuses an unknown machine and the machine the thread is on", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { hostId: "host-missing" },
            withChildren: false,
          }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { hostId: fx.sourceHostId },
            withChildren: false,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: { code: "thread_move_refused" },
        });
      });
    });
  });

  describe("with children", () => {
    function seedChild(
      harness: TestAppHarness,
      fx: Fixture,
      args: {
        environmentId?: string;
        parentThreadId?: string;
        status?: "active" | "idle";
      } = {},
    ) {
      const child = seedThread(harness.deps, {
        projectId: fx.projectId,
        environmentId: args.environmentId ?? fx.sourceEnvironmentId,
        parentThreadId: args.parentThreadId ?? fx.threadId,
        providerId: "claude-code",
        status: args.status ?? "idle",
      });
      seedThreadIdentity(harness.deps, {
        threadId: child.id,
        environmentId: child.environmentId ?? fx.sourceEnvironmentId,
        providerThreadId: `claude-session-${child.id}`,
      });
      return child;
    }

    function allMoves(harness: TestAppHarness) {
      return harness.db.select().from(threadMoves).all();
    }

    it("moves the thread and its descendants together in one group", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const child = seedChild(harness, fx);
        const grandchild = seedChild(harness, fx, {
          parentThreadId: child.id,
        });
        const archived = seedChild(harness, fx);
        archiveThread(harness.db, harness.deps.hub, archived.id);

        const result = await moveThread(harness.deps, {
          threadId: fx.threadId,
          target: { environmentId: fx.targetEnvironmentId },
          withChildren: true,
        });

        expect(result.phase).toBe("done");
        expect([...result.threadIds].sort()).toEqual(
          [fx.threadId, child.id, grandchild.id].sort(),
        );
        for (const id of result.threadIds) {
          expect(getThread(harness.db, id)?.environmentId).toBe(
            fx.targetEnvironmentId,
          );
          expect(operationMessages(harness, id)).toHaveLength(1);
        }
        expect(getThread(harness.db, archived.id)?.environmentId).toBe(
          fx.sourceEnvironmentId,
        );
        const moves = allMoves(harness);
        expect(moves).toHaveLength(3);
        expect(new Set(moves.map((move) => move.groupId))).toEqual(
          new Set([result.groupId]),
        );
        expect(moves.every((move) => move.phase === "done")).toBe(true);
        expect(
          fx.source.types().filter((type) => type === "thread.transfer.finish"),
        ).toHaveLength(3);
      });
    });

    it("leaves children behind without the flag", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const child = seedChild(harness, fx);
        const result = await moveThread(harness.deps, {
          threadId: fx.threadId,
          target: { environmentId: fx.targetEnvironmentId },
          withChildren: false,
        });
        expect(result.threadIds).toEqual([fx.threadId]);
        expect(getThread(harness.db, child.id)?.environmentId).toBe(
          fx.sourceEnvironmentId,
        );
      });
    });

    it("refuses children on another environment and lists their ids", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const elsewhere = seedEnvironment(harness.deps, {
          hostId: fx.targetHostId,
          projectId: fx.projectId,
          path: "/work/elsewhere",
        });
        const same = seedChild(harness, fx);
        const foreign = seedChild(harness, fx, {
          environmentId: elsewhere.id,
        });
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: true,
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: {
            code: "thread_move_refused",
            message: expect.stringContaining(foreign.id),
          },
        });
        expect(allMoves(harness)).toEqual([]);
        expect(getThread(harness.db, same.id)?.environmentId).toBe(
          fx.sourceEnvironmentId,
        );
        expect(fx.source.commands).toEqual([]);
      });
    });

    it("refuses a running child with or without the flag and moves nothing", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const running = seedChild(harness, fx, { status: "active" });
        for (const withChildren of [true, false]) {
          await expect(
            moveThread(harness.deps, {
              threadId: fx.threadId,
              target: { environmentId: fx.targetEnvironmentId },
              withChildren,
            }),
          ).rejects.toMatchObject({
            status: 409,
            body: { code: "thread_move_refused" },
          });
        }
        expect(allMoves(harness)).toEqual([]);
        expect(getThread(harness.db, running.id)?.environmentId).toBe(
          fx.sourceEnvironmentId,
        );
      });
    });

    it("rolls every thread back when a later thread fails before the switch", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness, {
          source: { failOn: "thread.transfer.export", failAfter: 1 },
        });
        const child = seedChild(harness, fx);

        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: true,
          }),
        ).rejects.toMatchObject({ body: { code: "thread_move_failed" } });

        for (const id of [fx.threadId, child.id]) {
          expect(getThread(harness.db, id)?.environmentId).toBe(
            fx.sourceEnvironmentId,
          );
          expect(getUnfinishedThreadMove(harness.db, id)).toBeNull();
          expect(operationMessages(harness, id)).toEqual([]);
        }
        const moves = allMoves(harness);
        expect(moves).toHaveLength(2);
        expect(moves.every((move) => move.phase === "failed")).toBe(true);
        expect(
          fx.target
            .types()
            .filter((type) => type === "thread.transfer.rollback"),
        ).toHaveLength(2);
        expect(
          fx.source
            .types()
            .filter((type) => type === "thread.transfer.rollback"),
        ).toHaveLength(2);
        expect(fx.target.types()).not.toContain("thread.transfer.finish");
      });
    });

    it("rolls every thread back when the target commit of a later thread fails", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness, {
          target: { failOn: "thread.transfer.commit", failAfter: 1 },
        });
        const child = seedChild(harness, fx);

        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: true,
          }),
        ).rejects.toMatchObject({ body: { code: "thread_move_failed" } });

        for (const id of [fx.threadId, child.id]) {
          expect(getThread(harness.db, id)?.environmentId).toBe(
            fx.sourceEnvironmentId,
          );
        }
        expect(allMoves(harness).map((move) => move.phase)).toEqual([
          "failed",
          "failed",
        ]);
      });
    });

    it("switches no thread when the final transaction rejects one", async () => {
      await withTestHarness(async (harness) => {
        let childId = "";
        const fx = setup(harness, {
          target: {
            onCommit: (command) => {
              if (
                command.type === "thread.transfer.commit" &&
                command.threadId === childId
              ) {
                harness.db
                  .update(threadMoves)
                  .set({ phase: "failed" })
                  .where(eq(threadMoves.threadId, fx.threadId))
                  .run();
              }
            },
          },
        });
        childId = seedChild(harness, fx).id;
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: true,
          }),
        ).rejects.toBeInstanceOf(ApiError);
        for (const id of [fx.threadId, childId]) {
          expect(getThread(harness.db, id)?.environmentId).toBe(
            fx.sourceEnvironmentId,
          );
          expect(operationMessages(harness, id)).toEqual([]);
        }
      });
    });
  });

  describe("plugin event", () => {
    function recordMoved() {
      const moved: unknown[] = [];
      const emitter: PluginThreadEventEmitter = {
        emitThreadEvents: () => {},
        emitTerminalInput: () => {},
        emitHostDeleted: () => {},
        emitEnvironmentRemoved: () => {},
        emitThreadCreated: () => {},
        emitThreadActive: () => {},
        emitThreadIdle: () => {},
        emitThreadFailed: () => {},
        emitThreadArchived: () => {},
        emitThreadDeleted: () => {},
        emitThreadRead: () => {},
        emitThreadMoved: (payload) => moved.push(payload),
        emitInteractionPending: () => {},
        emitMessageQueued: () => {},
        emitMessageDispatched: () => {},
        emitMessageCancelled: () => {},
        emitThreadUnarchived: () => {},
        emitThreadParentChanged: () => {},
        emitTurnFailed: () => {},
      };
      setPluginThreadEventEmitter(emitter);
      return moved;
    }

    it("announces each switched thread once and nothing for a failed move", async () => {
      await withTestHarness(async (harness) => {
        const moved = recordMoved();
        try {
          const failing = setup(harness, {
            source: { failOn: "thread.transfer.export" },
          });
          await expect(
            moveThread(harness.deps, {
              threadId: failing.threadId,
              target: { environmentId: failing.targetEnvironmentId },
              withChildren: false,
            }),
          ).rejects.toBeInstanceOf(ApiError);
          expect(moved).toEqual([]);
        } finally {
          setPluginThreadEventEmitter(undefined);
        }
      });
      await withTestHarness(async (harness) => {
        const moved = recordMoved();
        try {
          const fx = setup(harness);
          const result = await moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: false,
          });
          expect(moved).toEqual([
            {
              threadId: fx.threadId,
              moveId: result.moveId,
              sourceEnvironmentId: fx.sourceEnvironmentId,
              targetEnvironmentId: fx.targetEnvironmentId,
              sourceHostId: fx.sourceHostId,
              targetHostId: fx.targetHostId,
            },
          ]);
        } finally {
          setPluginThreadEventEmitter(undefined);
        }
      });
    });
  });

  describe("preflight", () => {
    const refusals: Array<{
      name: string;
      prepare: (harness: TestAppHarness, fx: Fixture) => void;
      options?: { providerId?: string };
    }> = [
      {
        name: "a provider other than claude-code",
        prepare: () => undefined,
        options: { providerId: "codex" },
      },
      {
        name: "a thread that is not idle",
        prepare: (harness, fx) => {
          harness.db.run(
            `UPDATE threads SET status = 'active' WHERE id = '${fx.threadId}'` as never,
          );
        },
      },
      {
        name: "queued messages",
        prepare: (harness, fx) => {
          seedQueuedMessage(harness.deps, {
            threadId: fx.threadId,
            content: [{ type: "text", text: "later", mentions: [] }],
          });
        },
      },
      {
        name: "an archived thread",
        prepare: (harness, fx) => {
          archiveThread(harness.db, harness.hub, fx.threadId);
        },
      },
      {
        name: "a running child thread",
        prepare: (harness, fx) => {
          seedThread(harness.deps, {
            projectId: fx.projectId,
            environmentId: fx.sourceEnvironmentId,
            parentThreadId: fx.threadId,
            status: "active",
          });
        },
      },
      {
        name: "an open terminal",
        prepare: (harness, fx) => {
          createTerminalSession(harness.db, {
            cols: 80,
            rows: 24,
            daemonSessionId: null,
            environmentId: fx.sourceEnvironmentId,
            hostId: fx.sourceHostId,
            initialCwd: "/work/a",
            status: "running",
            threadId: fx.threadId,
            title: "shell",
          });
        },
      },
      {
        name: "a target on the same machine",
        prepare: (harness, fx) => {
          const sameHost = seedEnvironment(harness.deps, {
            hostId: fx.sourceHostId,
            projectId: fx.projectId,
            path: "/work/a2",
          });
          fx.targetEnvironmentId = sameHost.id;
        },
      },
      {
        name: "a target that is not ready",
        prepare: (harness, fx) => {
          const pending = seedEnvironment(harness.deps, {
            hostId: fx.targetHostId,
            projectId: fx.projectId,
            path: null,
            status: "provisioning",
          });
          fx.targetEnvironmentId = pending.id;
        },
      },
      {
        name: "a target in another project",
        prepare: (harness, fx) => {
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: fx.targetHostId,
            path: "/other",
          });
          const other = seedEnvironment(harness.deps, {
            hostId: fx.targetHostId,
            projectId: project.id,
            path: "/work/other",
          });
          fx.targetEnvironmentId = other.id;
        },
      },
      {
        name: "a thread without a provider session",
        prepare: (harness, fx) => {
          harness.db
            .delete(events)
            .where(eq(events.threadId, fx.threadId))
            .run();
        },
      },
    ];

    for (const refusal of refusals) {
      it(`refuses ${refusal.name}`, async () => {
        await withTestHarness(async (harness) => {
          const fx = setup(harness, refusal.options);
          refusal.prepare(harness, fx);

          await expect(
            moveThread(harness.deps, {
              threadId: fx.threadId,
              target: { environmentId: fx.targetEnvironmentId },
              withChildren: false,
            }),
          ).rejects.toBeInstanceOf(ApiError);

          expect(getUnfinishedThreadMove(harness.db, fx.threadId)).toBeNull();
          expect(fx.source.commands).toEqual([]);
          expect(fx.target.commands).toEqual([]);
          expect(getThread(harness.db, fx.threadId)?.environmentId).toBe(
            fx.sourceEnvironmentId,
          );
        });
      });
    }

    it("refuses a second move while one is unfinished", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        insertMove(harness, fx);
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: false,
          }),
        ).rejects.toMatchObject({ status: 409 });
      });
    });
  });

  describe("fence", () => {
    it("refuses a send that raced the move in the final transaction", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        const staleThread = getThread(harness.db, fx.threadId)!;
        const environment = harness.db
          .select()
          .from((await import("@bb/db")).environments)
          .where(
            eq(
              (await import("@bb/db")).environments.id,
              fx.sourceEnvironmentId,
            ),
          )
          .get()!;
        insertMove(harness, fx);

        await expect(
          sendThreadMessage(harness.deps, {
            environment,
            originPluginId: null,
            payload: {
              input: [{ type: "text", text: "hello", mentions: [] }],
              mode: "start",
              permissionMode: "full",
              model: "claude-sonnet-5-5",
              reasoningLevel: "medium",
              serviceTier: "default",
            },
            thread: staleThread,
            trigger: "user",
          }),
        ).rejects.toMatchObject({
          status: 409,
          body: {
            code: "thread_moving",
            message: `Thread ${fx.threadId} is moving to another machine.`,
          },
        });
        expect(
          harness.db
            .select()
            .from(events)
            .where(eq(events.threadId, fx.threadId))
            .all()
            .filter((row) => row.type === "client/turn/requested"),
        ).toEqual([]);
      });
    });

    it("refuses sends through the API and stops once the move has switched", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        insertMove(harness, fx);
        const response = await harness.app.request(
          `/api/v1/threads/${fx.threadId}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "hello", mentions: [] }],
              mode: "start",
            }),
          },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "thread_moving",
        });

        const deleted = await harness.app.request(
          `/api/v1/threads/${fx.threadId}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ childThreadsConfirmed: true }),
          },
        );
        expect(deleted.status).toBe(409);
        expect(getThread(harness.db, fx.threadId)?.deletedAt).toBeNull();
      });
    });
  });

  describe("failure", () => {
    const failures: Array<{
      name: string;
      source?: FakeDaemonOptions;
      target?: FakeDaemonOptions;
      message: string;
    }> = [
      {
        name: "export",
        source: { failOn: "thread.transfer.export" },
        message: "thread.transfer.export exploded",
      },
      {
        name: "copy",
        target: { failOn: "thread.transfer.write_chunk" },
        message: "thread.transfer.write_chunk exploded",
      },
      {
        name: "commit",
        target: { failOn: "thread.transfer.commit" },
        message: "thread.transfer.commit exploded",
      },
      {
        name: "a staged size mismatch",
        target: { shortWrite: true },
        message: "Target staged",
      },
    ];

    for (const failure of failures) {
      it(`rolls back both sides when ${failure.name} fails`, async () => {
        await withTestHarness(async (harness) => {
          const fx = setup(harness, {
            source: failure.source,
            target: failure.target,
          });

          await expect(
            moveThread(harness.deps, {
              threadId: fx.threadId,
              target: { environmentId: fx.targetEnvironmentId },
              withChildren: false,
            }),
          ).rejects.toMatchObject({
            status: 409,
            body: { code: "thread_move_failed" },
          });

          const thread = getThread(harness.db, fx.threadId)!;
          expect(thread.environmentId).toBe(fx.sourceEnvironmentId);
          expect(fx.source.types().at(-1)).toBe("thread.transfer.rollback");
          expect(fx.target.types().at(-1)).toBe("thread.transfer.rollback");
          expect(fx.source.types()).not.toContain("thread.transfer.finish");
          expect(getUnfinishedThreadMove(harness.db, fx.threadId)).toBeNull();
          const rows = harness.db.all<{ phase: string; error: string }>(
            `SELECT phase, error FROM thread_moves` as never,
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]!.phase).toBe("failed");
          expect(rows[0]!.error).toContain(failure.message);
          expect(operationMessages(harness, fx.threadId)).toEqual([]);
        });
      });
    }
  });

  describe("recovery", () => {
    it("rolls back moves that never switched", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        insertMove(harness, fx);
        updateThreadMovePhase(harness.db, {
          id: "mv_test",
          expectedPhase: "preparing",
          phase: "copying",
          now: Date.now(),
        });

        await recoverThreadMoves(harness.deps);

        expect(getThreadMove(harness.db, "mv_test")?.phase).toBe("rolled_back");
        expect(fx.source.types()).toEqual(["thread.transfer.rollback"]);
        expect(fx.target.types()).toEqual(["thread.transfer.rollback"]);
        expect(getThread(harness.db, fx.threadId)?.environmentId).toBe(
          fx.sourceEnvironmentId,
        );
      });
    });

    it("finishes moves that already switched", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        insertMove(harness, fx);
        for (const [from, to] of [
          ["preparing", "exporting"],
          ["exporting", "copying"],
          ["copying", "committing"],
          ["committing", "switched"],
        ] as const) {
          updateThreadMovePhase(harness.db, {
            id: "mv_test",
            expectedPhase: from,
            phase: to,
            now: Date.now(),
          });
        }

        await recoverThreadMoves(harness.deps);

        expect(getThreadMove(harness.db, "mv_test")?.phase).toBe("done");
        expect(fx.source.commands[0]).toMatchObject({
          type: "thread.transfer.finish",
          setAsideSession: { cwd: "/work/a" },
        });
        expect(fx.target.commands[0]).toMatchObject({
          type: "thread.transfer.finish",
          setAsideSession: null,
        });
      });
    });

    it("releases the thread at once when a daemon is disconnected", async () => {
      await withTestHarness(async (harness) => {
        const fx = setup(harness);
        insertMove(harness, fx);
        harness.hub.unregisterDaemon(
          harness.hub.getDaemonSessionIdForHost(fx.targetHostId)!,
        );

        await recoverThreadMoves(harness.deps);

        expect(getThreadMove(harness.db, "mv_test")?.phase).toBe(
          "cleanup_pending",
        );
        expect(isThreadMoveInProgress(harness.db, fx.threadId)).toBe(false);
        expect(getThread(harness.db, fx.threadId)?.environmentId).toBe(
          fx.sourceEnvironmentId,
        );
        expect(fx.source.commands).toEqual([]);
        expect(fx.target.commands).toEqual([]);
      });
    });

    it("keeps cleaning up after a failed rollback without fencing the thread", async () => {
      await withTestHarness(async (harness) => {
        const targetOptions: FakeDaemonOptions = {
          failOn: "thread.transfer.rollback",
        };
        const fx = setup(harness, {
          source: { failOn: "thread.transfer.export" },
          target: targetOptions,
        });
        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: false,
          }),
        ).rejects.toMatchObject({ body: { code: "thread_move_failed" } });
        const [first] = listCleanupPendingThreadMoves(harness.db, fx.threadId);
        expect(first?.phase).toBe("cleanup_pending");
        expect(isThreadMoveInProgress(harness.db, fx.threadId)).toBe(false);

        await expect(
          moveThread(harness.deps, {
            threadId: fx.threadId,
            target: { environmentId: fx.targetEnvironmentId },
            withChildren: false,
          }),
        ).rejects.toMatchObject({ body: { code: "thread_move_refused" } });

        targetOptions.failOn = undefined;
        await recoverThreadMoves(harness.deps);
        expect(getThreadMove(harness.db, first!.id)?.phase).toBe("rolled_back");
        expect(listCleanupPendingThreadMoves(harness.db, fx.threadId)).toEqual(
          [],
        );
      });
    });
  });
});
