import { getUnfinishedThreadMove, type DbQueryConnection } from "@bb/db";
import { isThreadMovePreSwitch, threadMovingMessage } from "@bb/domain";
import { ApiError } from "../../errors.js";

export function isThreadMoveInProgress(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  const move = getUnfinishedThreadMove(db, threadId);
  return move !== null && isThreadMovePreSwitch(move.phase);
}

export function assertThreadNotMoving(
  db: DbQueryConnection,
  threadId: string,
): void {
  if (isThreadMoveInProgress(db, threadId)) {
    throw new ApiError(409, "thread_moving", threadMovingMessage(threadId));
  }
}
