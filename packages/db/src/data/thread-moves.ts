import { and, asc, eq, notInArray } from "drizzle-orm";
import type { ThreadMovePhase } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { threadMoves } from "../schema.js";

export type ThreadMoveRow = typeof threadMoves.$inferSelect;

export interface CreateThreadMoveArgs {
  id: string;
  now: number;
  providerId: string;
  providerThreadId: string;
  sourceCwd: string;
  sourceEnvironmentId: string;
  sourceHostId: string;
  targetCwd: string;
  targetEnvironmentId: string;
  targetHostId: string;
  threadId: string;
}

export interface UpdateThreadMovePhaseArgs {
  error?: string | null;
  expectedPhase: ThreadMovePhase;
  id: string;
  now: number;
  phase: ThreadMovePhase;
}

const FINISHED_PHASES: ThreadMovePhase[] = ["done", "failed", "rolled_back"];

export function createThreadMove(
  db: DbQueryConnection,
  args: CreateThreadMoveArgs,
): ThreadMoveRow {
  return db
    .insert(threadMoves)
    .values({
      id: args.id,
      threadId: args.threadId,
      sourceEnvironmentId: args.sourceEnvironmentId,
      targetEnvironmentId: args.targetEnvironmentId,
      sourceHostId: args.sourceHostId,
      targetHostId: args.targetHostId,
      providerId: args.providerId,
      providerThreadId: args.providerThreadId,
      sourceCwd: args.sourceCwd,
      targetCwd: args.targetCwd,
      phase: "preparing",
      error: null,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .returning()
    .get();
}

export function getThreadMove(
  db: DbQueryConnection,
  id: string,
): ThreadMoveRow | null {
  return (
    db.select().from(threadMoves).where(eq(threadMoves.id, id)).get() ?? null
  );
}

export function getUnfinishedThreadMove(
  db: DbQueryConnection,
  threadId: string,
): ThreadMoveRow | null {
  return (
    db
      .select()
      .from(threadMoves)
      .where(
        and(
          eq(threadMoves.threadId, threadId),
          notInArray(threadMoves.phase, FINISHED_PHASES),
        ),
      )
      .get() ?? null
  );
}

export function listUnfinishedThreadMoves(
  db: DbQueryConnection,
): ThreadMoveRow[] {
  return db
    .select()
    .from(threadMoves)
    .where(notInArray(threadMoves.phase, FINISHED_PHASES))
    .orderBy(asc(threadMoves.createdAt), asc(threadMoves.id))
    .all();
}

export function updateThreadMovePhase(
  db: DbQueryConnection,
  args: UpdateThreadMovePhaseArgs,
): boolean {
  return (
    db
      .update(threadMoves)
      .set({
        phase: args.phase,
        updatedAt: args.now,
        ...(args.error !== undefined ? { error: args.error } : {}),
      })
      .where(
        and(
          eq(threadMoves.id, args.id),
          eq(threadMoves.phase, args.expectedPhase),
        ),
      )
      .run().changes === 1
  );
}
