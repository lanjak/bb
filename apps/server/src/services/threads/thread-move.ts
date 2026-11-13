import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  countTerminalSessions,
  createEventId,
  createThreadMove,
  getEnvironment,
  getHost,
  getLastStoredProviderThreadId,
  getLatestThreadSequence,
  getThread,
  getThreadMove,
  getUnfinishedThreadMove,
  listNonDeletedChildThreads,
  listPendingInteractionsByThread,
  listQueuedThreadMessages,
  listCleanupPendingThreadMoves,
  listUnfinishedThreadMoves,
  updateThread,
  updateThreadMovePhase,
  type DbQueryConnection,
  type ThreadMoveRow,
} from "@bb/db";
import { isThreadMovePreSwitch, threadScope } from "@bb/domain";
import type { ThreadMovePhase } from "@bb/domain";
import {
  THREAD_TRANSFER_CHUNK_MAX_BYTES,
  type HostDaemonRetryableOnlineRpcCommand,
  type HostDaemonOnlineRpcResultForCommand,
  type ThreadTransferFile,
  type ThreadTransferSessionEnvironment,
} from "@bb/host-daemon-contract";
import type { MoveThreadResponse } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { resolveBridgeLaunchForProviderId } from "../system/provider-bridge-launch.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import { resolveReuseThreadRequestEnvironment } from "./thread-request-eligibility.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import {
  mergeHostAndProviderEnvironment,
  resolveHostEnvironment,
} from "../hosts/host-environment.js";
import { resolvePluginProviderEnv } from "../plugins/plugin-agent-contributions.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";

type MoveDeps = LoggedPendingInteractionWorkSessionDeps;

const THREAD_MOVE_RPC_TIMEOUT_MS = 5 * 60_000;
export const THREAD_MOVE_OPERATION = "thread_move";

const activeMoveIds = new Set<string>();

interface MovePlan {
  providerThreadId: string;
  sourceCwd: string;
  sourceEnvironmentId: string;
  sourceHostId: string;
  targetCwd: string;
  targetEnvironmentId: string;
  targetHostId: string;
}

function refuse(message: string): never {
  throw new ApiError(409, "thread_move_refused", message);
}

function planThreadMove(
  db: DbQueryConnection,
  args: {
    ownMoveId: string | null;
    targetEnvironmentId: string;
    threadId: string;
  },
): MovePlan {
  const thread = getThread(db, args.threadId);
  if (thread === null || thread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  if (thread.archivedAt !== null) refuse("Archived threads cannot be moved.");
  if (thread.status !== "idle") {
    refuse(`Only idle threads can be moved; this thread is ${thread.status}.`);
  }
  const unfinished = getUnfinishedThreadMove(db, thread.id);
  if (unfinished !== null && unfinished.id !== args.ownMoveId) {
    refuse(`Thread ${thread.id} is already moving to another machine.`);
  }
  if (thread.environmentId === null) {
    refuse("The thread has no environment to move from.");
  }
  const source = getEnvironment(db, thread.environmentId);
  if (source === null || source.status !== "ready" || source.path === null) {
    refuse("The thread's current environment is not ready.");
  }
  const target = getEnvironment(db, args.targetEnvironmentId);
  if (target === null) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  if (target.status !== "ready" || target.path === null) {
    refuse(`Target environment is ${target.status}, not ready.`);
  }
  if (target.projectId !== thread.projectId) {
    refuse("Target environment belongs to a different project.");
  }
  if (target.hostId === source.hostId) {
    refuse("Target environment is on the same machine as the thread.");
  }
  const providerThreadId = getLastStoredProviderThreadId(db, thread.id);
  if (providerThreadId === null) {
    refuse("The thread has no provider session to move.");
  }
  if (listQueuedThreadMessages(db, thread.id).length > 0) {
    refuse("Thread has queued messages; send or delete them first.");
  }
  if (
    listPendingInteractionsByThread(db, {
      threadId: thread.id,
      statuses: ["pending", "resolving"],
    }).length > 0
  ) {
    refuse("Thread has pending interactions; resolve them first.");
  }
  if (
    listNonDeletedChildThreads(db, { parentThreadId: thread.id }).some(
      (child) =>
        child.archivedAt === null &&
        (child.status === "active" ||
          child.status === "starting" ||
          child.status === "stopping"),
    )
  ) {
    refuse("Thread has running child threads; wait for them to finish.");
  }
  if (
    countTerminalSessions(db, {
      scope: { kind: "thread", threadId: thread.id },
      visible: true,
    }) > 0
  ) {
    refuse("Thread has open terminals; close them first.");
  }
  return {
    providerThreadId,
    sourceCwd: source.path,
    sourceEnvironmentId: source.id,
    sourceHostId: source.hostId,
    targetCwd: target.path,
    targetEnvironmentId: target.id,
    targetHostId: target.hostId,
  };
}

function requireBridgeLaunch(deps: MoveDeps, providerId: string) {
  const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, providerId);
  if (bridgeLaunch === null) {
    refuse(`Provider bridge is unavailable for ${providerId}.`);
  }
  return bridgeLaunch;
}

function rpc<TCommand extends HostDaemonRetryableOnlineRpcCommand>(
  deps: MoveDeps,
  hostId: string,
  command: TCommand,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
  return callHostRetryableOnlineRpc(deps, {
    command,
    hostId,
    timeoutMs: THREAD_MOVE_RPC_TIMEOUT_MS,
  });
}

function sessionArgs(move: ThreadMoveRow, cwd: string) {
  return {
    cwd,
    providerId: move.providerId,
    providerThreadId: move.providerThreadId,
    threadId: move.threadId,
  };
}

async function sessionEnvironment(
  deps: MoveDeps,
  move: ThreadMoveRow,
  side: "source" | "target",
): Promise<ThreadTransferSessionEnvironment> {
  const thread = getThread(deps.db, move.threadId);
  if (thread === null) {
    throw new Error(`Thread ${move.threadId} no longer exists`);
  }
  const hostId = side === "source" ? move.sourceHostId : move.targetHostId;
  return {
    projectId: thread.projectId,
    environmentId:
      side === "source" ? move.sourceEnvironmentId : move.targetEnvironmentId,
    contributedEnv: mergeHostAndProviderEnvironment(
      await resolveHostEnvironment(deps, {
        hostId,
        projectId: thread.projectId,
      }),
      await resolvePluginProviderEnv({
        providerId: move.providerId,
        context: { threadId: thread.id, projectId: thread.projectId, hostId },
      }),
    ),
  };
}

function toResponse(move: ThreadMoveRow): MoveThreadResponse {
  return {
    error: move.error,
    moveId: move.id,
    phase: move.phase,
    sourceEnvironmentId: move.sourceEnvironmentId,
    targetEnvironmentId: move.targetEnvironmentId,
    threadId: move.threadId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function advance(
  deps: MoveDeps,
  move: ThreadMoveRow,
  from: ThreadMovePhase,
  to: ThreadMovePhase,
  error?: string | null,
): ThreadMoveRow {
  const changed = updateThreadMovePhase(deps.db, {
    id: move.id,
    expectedPhase: from,
    phase: to,
    now: Date.now(),
    ...(error === undefined ? {} : { error }),
  });
  if (!changed) {
    throw new Error(`Thread move ${move.id} is no longer in phase ${from}`);
  }
  return getThreadMove(deps.db, move.id) ?? move;
}

async function copyFile(
  deps: MoveDeps,
  move: ThreadMoveRow,
  file: ThreadTransferFile,
): Promise<void> {
  let offset = 0;
  let stagedSize = -1;
  do {
    const length = Math.min(
      THREAD_TRANSFER_CHUNK_MAX_BYTES,
      file.sizeBytes - offset,
    );
    let contentBase64 = "";
    let received = 0;
    if (length > 0) {
      const chunk = await rpc(deps, move.sourceHostId, {
        type: "thread.transfer.read_chunk",
        transferId: move.id,
        relativePath: file.relativePath,
        offset,
        length,
      });
      received = Buffer.from(chunk.contentBase64, "base64").length;
      if (chunk.offset !== offset || received === 0 || received > length) {
        throw new Error(
          `Source returned an unexpected chunk for ${file.relativePath}`,
        );
      }
      contentBase64 = chunk.contentBase64;
    }
    const written = await rpc(deps, move.targetHostId, {
      type: "thread.transfer.write_chunk",
      transferId: move.id,
      relativePath: file.relativePath,
      offset,
      contentBase64,
    });
    offset += received;
    stagedSize = written.sizeBytes;
    if (stagedSize !== offset) {
      throw new Error(
        `Target staged ${stagedSize} bytes of ${file.relativePath}, expected ${offset}`,
      );
    }
  } while (offset < file.sizeBytes);
  if (stagedSize !== file.sizeBytes) {
    throw new Error(
      `Size mismatch for ${file.relativePath}: staged ${stagedSize}, expected ${file.sizeBytes}`,
    );
  }
}

async function rollbackBothSides(
  deps: MoveDeps,
  move: ThreadMoveRow,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [side, hostId] of [
    ["target", move.targetHostId],
    ["source", move.sourceHostId],
  ] as const) {
    try {
      await rpc(deps, hostId, {
        type: "thread.transfer.rollback",
        transferId: move.id,
      });
    } catch (error) {
      failures.push(`${side} rollback failed: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function finishBothSides(
  deps: MoveDeps,
  move: ThreadMoveRow,
): Promise<void> {
  await rpc(deps, move.sourceHostId, {
    type: "thread.transfer.finish",
    transferId: move.id,
    setAsideSession: sessionArgs(move, move.sourceCwd),
    bridgeLaunch: requireBridgeLaunch(deps, move.providerId),
    sessionEnvironment: await sessionEnvironment(deps, move, "source"),
  });
  await rpc(deps, move.targetHostId, {
    type: "thread.transfer.finish",
    transferId: move.id,
    setAsideSession: null,
    bridgeLaunch: null,
    sessionEnvironment: await sessionEnvironment(deps, move, "target"),
  });
}

function switchThreadEnvironment(deps: MoveDeps, move: ThreadMoveRow): void {
  deps.db.transaction(
    (tx) => {
      const current = getThreadMove(tx, move.id);
      if (current === null || current.phase !== "committing") {
        throw new Error(`Thread move ${move.id} is not ready to switch`);
      }
      const plan = planThreadMove(tx, {
        ownMoveId: move.id,
        targetEnvironmentId: move.targetEnvironmentId,
        threadId: move.threadId,
      });
      const thread = getThread(tx, move.threadId);
      if (
        thread === null ||
        thread.environmentId !== move.sourceEnvironmentId ||
        plan.targetHostId !== move.targetHostId ||
        plan.sourceHostId !== move.sourceHostId
      ) {
        throw new Error("Thread environment changed during the move");
      }
      const sourceHost = getHost(tx, move.sourceHostId);
      const targetHost = getHost(tx, move.targetHostId);
      updateThread(tx, deps.hub, move.threadId, {
        environmentId: move.targetEnvironmentId,
      });
      updateThreadMovePhase(tx, {
        id: move.id,
        expectedPhase: "committing",
        phase: "switched",
        now: Date.now(),
      });
      appendThreadEventInTransaction(tx, {
        threadId: move.threadId,
        environmentId: move.targetEnvironmentId,
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: THREAD_MOVE_OPERATION,
          operationId: createEventId(),
          status: "completed",
          message: `Moved from ${sourceHost?.name ?? move.sourceHostId} (${move.sourceCwd}) to ${targetHost?.name ?? move.targetHostId} (${move.targetCwd})`,
          metadata: {
            moveId: move.id,
            sourceEnvironmentId: move.sourceEnvironmentId,
            targetEnvironmentId: move.targetEnvironmentId,
            sourceHostId: move.sourceHostId,
            targetHostId: move.targetHostId,
          },
        },
      });
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(move.threadId, ["events-appended"], {
    timelineSequence: getLatestThreadSequence(deps.db, {
      threadId: move.threadId,
    }),
    eventTypes: ["system/operation"],
  });
}

async function finishAfterSwitch(
  deps: MoveDeps,
  move: ThreadMoveRow,
): Promise<ThreadMoveRow> {
  let current = move;
  if (current.phase === "switched") {
    current = advance(deps, current, "switched", "finishing");
  }
  try {
    await finishBothSides(deps, current);
  } catch (error) {
    const message = `Finishing the move failed and will be retried: ${errorMessage(error)}`;
    deps.logger.warn({ err: error, moveId: move.id }, message);
    updateThreadMovePhase(deps.db, {
      id: move.id,
      expectedPhase: "finishing",
      phase: "finishing",
      now: Date.now(),
      error: message,
    });
    return getThreadMove(deps.db, move.id) ?? current;
  }
  return advance(deps, current, "finishing", "done", null);
}

export async function moveThread(
  deps: MoveDeps,
  args: { environmentId: string; threadId: string },
): Promise<MoveThreadResponse> {
  const thread = getThread(deps.db, args.threadId);
  if (thread === null || thread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  if (!deps.providerRegistry.supportsSessionTransfer(thread.providerId)) {
    refuse(
      `Provider ${thread.providerId} does not support moving threads between machines.`,
    );
  }
  const preflight = planThreadMove(deps.db, {
    ownMoveId: null,
    targetEnvironmentId: args.environmentId,
    threadId: args.threadId,
  });
  resolveReuseThreadRequestEnvironment(
    deps,
    { type: "reuse", environmentId: args.environmentId },
    thread.projectId,
  );
  const bridgeLaunch = requireBridgeLaunch(deps, thread.providerId);
  requireConnectedHostSession(deps, preflight.sourceHostId);
  requireConnectedHostSession(deps, preflight.targetHostId);
  await settleEarlierCleanups(deps, args.threadId);

  let move = deps.db.transaction(
    (tx) => {
      const plan = planThreadMove(tx, {
        ownMoveId: null,
        targetEnvironmentId: args.environmentId,
        threadId: args.threadId,
      });
      return createThreadMove(tx, {
        ...plan,
        id: `mv_${randomUUID()}`,
        now: Date.now(),
        providerId: thread.providerId,
        threadId: args.threadId,
      });
    },
    { behavior: "immediate" },
  );
  activeMoveIds.add(move.id);
  try {
    try {
      await stopThreadForCurrentState(
        deps,
        thread,
        { id: move.sourceEnvironmentId, hostId: move.sourceHostId },
        { requireStopped: true },
      );
      move = advance(deps, move, "preparing", "exporting");
      const exported = await rpc(deps, move.sourceHostId, {
        type: "thread.transfer.export",
        transferId: move.id,
        ...sessionArgs(move, move.sourceCwd),
        bridgeLaunch,
        sessionEnvironment: await sessionEnvironment(deps, move, "source"),
      });
      move = advance(deps, move, "exporting", "copying");
      for (const file of exported.files) {
        await copyFile(deps, move, file);
      }
      move = advance(deps, move, "copying", "committing");
      await rpc(deps, move.targetHostId, {
        type: "thread.transfer.commit",
        transferId: move.id,
        ...sessionArgs(move, move.targetCwd),
        files: exported.files,
        bridgeLaunch,
        sessionEnvironment: await sessionEnvironment(deps, move, "target"),
      });
      switchThreadEnvironment(deps, move);
    } catch (error) {
      const latest = getThreadMove(deps.db, move.id) ?? move;
      if (isThreadMovePreSwitch(latest.phase)) {
        const rollbackFailures = await rollbackBothSides(deps, move);
        const message = [errorMessage(error), ...rollbackFailures].join("; ");
        updateThreadMovePhase(deps.db, {
          id: move.id,
          expectedPhase: latest.phase,
          phase: rollbackFailures.length === 0 ? "failed" : "cleanup_pending",
          now: Date.now(),
          error: message,
        });
        throw new ApiError(
          409,
          "thread_move_failed",
          `Moving thread ${args.threadId} failed: ${message}`,
        );
      }
      throw error;
    }
    move = getThreadMove(deps.db, move.id) ?? move;
    return toResponse(await finishAfterSwitch(deps, move));
  } finally {
    activeMoveIds.delete(move.id);
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: args.threadId,
    });
  }
}

function hostsConnected(deps: MoveDeps, move: ThreadMoveRow): boolean {
  return (
    deps.hub.getDaemonSessionIdForHost(move.sourceHostId) !== null &&
    deps.hub.getDaemonSessionIdForHost(move.targetHostId) !== null
  );
}

async function cleanUpMove(
  deps: MoveDeps,
  move: ThreadMoveRow,
): Promise<string[]> {
  const failures = await rollbackBothSides(deps, move);
  if (failures.length === 0) {
    updateThreadMovePhase(deps.db, {
      id: move.id,
      expectedPhase: "cleanup_pending",
      phase: "rolled_back",
      now: Date.now(),
    });
  } else {
    deps.logger.warn(
      { failures, moveId: move.id },
      "Thread move cleanup is incomplete; will retry",
    );
  }
  return failures;
}

async function settleEarlierCleanups(
  deps: MoveDeps,
  threadId: string,
): Promise<void> {
  for (const earlier of listCleanupPendingThreadMoves(deps.db, threadId)) {
    if (activeMoveIds.has(earlier.id)) continue;
    activeMoveIds.add(earlier.id);
    try {
      const failures = hostsConnected(deps, earlier)
        ? await cleanUpMove(deps, earlier)
        : ["a host is offline"];
      if (failures.length > 0) {
        refuse(
          `An earlier move of this thread is still cleaning up (${failures.join("; ")}). Reconnect both machines and try again.`,
        );
      }
    } finally {
      activeMoveIds.delete(earlier.id);
    }
  }
}

async function recoverMove(deps: MoveDeps, move: ThreadMoveRow): Promise<void> {
  let current = move;
  if (isThreadMovePreSwitch(current.phase)) {
    updateThreadMovePhase(deps.db, {
      id: current.id,
      expectedPhase: current.phase,
      phase: "cleanup_pending",
      now: Date.now(),
      error: "Interrupted before the switch; the thread stayed on its source",
    });
    current = getThreadMove(deps.db, current.id) ?? current;
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: current.threadId,
    });
  }
  if (!hostsConnected(deps, current)) {
    return;
  }
  if (current.phase === "cleanup_pending") {
    await cleanUpMove(deps, current);
  } else {
    await finishAfterSwitch(deps, current);
  }
  requestQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: move.threadId,
  });
}

export async function recoverThreadMoves(
  deps: MoveDeps,
  args: { hostId?: string } = {},
): Promise<void> {
  for (const move of listUnfinishedThreadMoves(deps.db)) {
    if (activeMoveIds.has(move.id)) continue;
    if (
      args.hostId !== undefined &&
      move.sourceHostId !== args.hostId &&
      move.targetHostId !== args.hostId
    ) {
      continue;
    }
    activeMoveIds.add(move.id);
    try {
      await recoverMove(deps, move);
    } catch (error) {
      deps.logger.warn(
        { err: error, moveId: move.id },
        "Thread move recovery failed; will retry",
      );
    } finally {
      activeMoveIds.delete(move.id);
    }
  }
}
