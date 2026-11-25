import { useEffect, useRef } from "react";
import type { Host } from "@bb/domain";
import { MACHINE_RECONNECT_FAILURE_PREFIX } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { MachineLaunchCommand } from "@/components/dialogs/AddMachineDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { machineExecutorPhrase } from "@/components/machines/machine-executor";
import { useReconnectHost } from "@/hooks/mutations/host-mutations";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export function MachineReconnectDialog({
  target,
  onOpenChange,
}: {
  target: Host | null;
  onOpenChange: (open: boolean) => void;
}) {
  const reconnectHost = useReconnectHost();
  const { providers } = useSystemMachineProviders();
  const hostId = target?.id ?? null;
  const { mutate, reset } = reconnectHost;
  useEffect(() => {
    if (hostId === null) {
      reset();
      return;
    }
    mutate({ hostId, printCommand: false });
  }, [hostId, mutate, reset]);

  const prepared = reconnectHost.data ?? null;
  const errorMessage = reconnectHost.isError
    ? getMutationErrorMessage({
        error: reconnectHost.error,
        fallbackMessage: "Couldn't prepare a reconnect command.",
      })
    : null;
  const provider =
    providers?.find((entry) => entry.id === target?.machineProviderId) ?? null;
  const reconnect = (printCommand: boolean) => {
    if (hostId !== null) mutate({ hostId, printCommand });
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onInteractOutside={(event) => event.preventDefault()}
      >
        {target === null ? null : (
          <MachineReconnectView
            host={target}
            executorPhrase={machineExecutorPhrase(provider)}
            prepared={prepared}
            errorMessage={errorMessage}
            onReconnect={reconnect}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MachineReconnectView({
  host,
  executorPhrase,
  prepared,
  errorMessage,
  onReconnect,
  onDone,
}: {
  host: Host;
  executorPhrase: string | null;
  prepared: ReturnType<typeof useReconnectHost>["data"] | null;
  errorMessage: string | null;
  onReconnect: (printCommand: boolean) => void;
  onDone: () => void;
}) {
  const title =
    host.lastRejectedProtocolVersion !== null && executorPhrase !== null
      ? `Update ${executorPhrase}`
      : "Reconnect machine";
  const overOperation = prepared?.mode === "operation";
  const via = executorPhrase ?? "through its provider";
  const description = overOperation
    ? `bb is reinstalling its daemon on ${host.name} ${via}. The machine keeps its projects, environments and history.`
    : `Run this command on ${host.name} to bring it back online. It keeps the machine's projects, environments and history.`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription
          className={
            errorMessage === null ? undefined : "text-destructive-text"
          }
        >
          {errorMessage ?? description}
        </DialogDescription>
      </DialogHeader>
      {errorMessage === null ? null : (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReconnect(false)}
          >
            Try again
          </Button>
        </div>
      )}
      {errorMessage === null && prepared?.mode === "command" ? (
        <>
          {prepared.unavailableReason === null ? null : (
            <p
              role="status"
              className="rounded-md bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
            >
              {`bb can't reconnect this machine ${via} right now: ${prepared.unavailableReason}`}
            </p>
          )}
          <MachineLaunchCommand
            key={prepared.command}
            command={prepared.command}
            windowsCommand={prepared.windowsCommand}
            expiresAt={prepared.expiresAt}
            onRegenerate={() => onReconnect(true)}
          />
        </>
      ) : null}
      {errorMessage === null && overOperation ? (
        <MachineReconnectOperation
          host={host}
          onRetry={() => onReconnect(false)}
          onShowCommand={() => onReconnect(true)}
          onDone={onDone}
        />
      ) : errorMessage === null ? (
        <ReconnectStatusRow
          connected={host.status === "connected"}
          pendingText={
            prepared === null
              ? "Preparing to reconnect..."
              : "Waiting for the machine to reconnect…"
          }
          connectedText={`${host.name} reconnected`}
          onDone={onDone}
        />
      ) : null}
    </>
  );
}

function MachineReconnectOperation({
  host,
  onRetry,
  onShowCommand,
  onDone,
}: {
  host: Host;
  onRetry: () => void;
  onShowCommand: () => void;
  onDone: () => void;
}) {
  const message = host.lifecycle.message;
  const failure = message?.startsWith(MACHINE_RECONNECT_FAILURE_PREFIX)
    ? message
    : null;
  const connected = host.status === "connected" && message === null;
  const logRef = useRef<HTMLPreElement>(null);
  const log = host.lifecycle.pendingLog;
  useEffect(() => {
    const element = logRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [log]);
  return (
    <>
      {log === "" ? null : (
        <pre
          ref={logRef}
          aria-label="Reconnect log"
          className="max-h-60 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground"
        >
          {log}
        </pre>
      )}
      {failure === null ? (
        <ReconnectStatusRow
          connected={connected}
          pendingText={message ?? "Waiting for the machine to reconnect…"}
          connectedText={`${host.name} reconnected`}
          onDone={onDone}
        />
      ) : (
        <p role="alert" className="text-xs text-destructive-text">
          {failure}
        </p>
      )}
      {connected ? null : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onShowCommand}>
            Show manual command
          </Button>
          {failure === null ? null : (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function ReconnectStatusRow({
  connected,
  pendingText,
  connectedText,
  onDone,
}: {
  connected: boolean;
  pendingText: string;
  connectedText: string;
  onDone: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
      {connected ? (
        <>
          <MachineStatusDot connected />
          <span
            role="status"
            className="min-w-0 flex-1 truncate text-sm text-foreground"
          >
            {connectedText}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onDone}
          >
            Done
          </Button>
        </>
      ) : (
        <>
          <Icon
            name="Spinner"
            className="size-4 shrink-0 animate-spin text-muted-foreground"
          />
          <span role="status" className="text-sm text-muted-foreground">
            {pendingText}
          </span>
        </>
      )}
    </div>
  );
}
