import { useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { processesContract, type ProcessRow } from "../../contract.js";

const CONFIRM_MS = 3_000;

const FAILURES = {
  "not-found": "The command is no longer running.",
  "not-stoppable": "This machine cannot stop that command.",
  changed: "The process changed. Refresh and try again.",
  "still-running": "The command did not exit.",
} as const;

export function StopButton({
  threadId,
  row,
}: {
  threadId: string;
  row: Pick<ProcessRow, "pid" | "startToken" | "name">;
}) {
  const [confirming, setConfirming] = useState(false);
  const stop = experimental_useRpcMutation({
    contract: processesContract,
    method: "processes.stop",
  });
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <button
      type="button"
      className={
        confirming
          ? "shrink-0 cursor-pointer rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive-text hover:bg-destructive/20"
          : "shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-50"
      }
      aria-label={
        confirming ? `Confirm stop of ${row.name}` : `Stop ${row.name}`
      }
      disabled={stop.isPending}
      onClick={() => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        stop
          .mutate({
            threadId,
            rootPid: row.pid,
            startToken: row.startToken,
          })
          .then(({ outcome }) => {
            if (outcome !== "stopped") toast.error(FAILURES[outcome]);
          })
          .catch((error: unknown) => {
            toast.error(
              error instanceof Error
                ? error.message
                : `Failed to stop ${row.name}.`,
            );
          });
      }}
    >
      {confirming ? "Confirm stop" : "Stop"}
    </button>
  );
}
