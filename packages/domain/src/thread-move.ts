import { z } from "zod";

export const threadMovePhaseValues = [
  "preparing",
  "exporting",
  "copying",
  "committing",
  "switched",
  "finishing",
  "done",
  "failed",
  "cleanup_pending",
  "rolled_back",
] as const;
export const threadMovePhaseSchema = z.enum(threadMovePhaseValues);
export type ThreadMovePhase = z.infer<typeof threadMovePhaseSchema>;

export const threadMoveReleasedPhaseValues = [
  "done",
  "failed",
  "cleanup_pending",
  "rolled_back",
] as const satisfies readonly ThreadMovePhase[];

export const threadMoveSettledPhaseValues = [
  "done",
  "failed",
  "rolled_back",
] as const satisfies readonly ThreadMovePhase[];

export function isThreadMovePreSwitch(phase: ThreadMovePhase): boolean {
  return (
    phase === "preparing" ||
    phase === "exporting" ||
    phase === "copying" ||
    phase === "committing"
  );
}

export function threadMovingMessage(threadId: string): string {
  return `Thread ${threadId} is moving to another machine.`;
}
