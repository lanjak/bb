import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { Link } from "react-router-dom";
import type { Host, JsonValue } from "@bb/domain";
import type { SystemMachineProvider } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { MachineProgressLog } from "@/components/machines/MachineProgressLog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { useMachineProviderInputs } from "@/components/pickers/machine-provider-inputs";
import { getSettingsTargetPath } from "@/components/settings/settings-sections";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

const POLL_MS = 1_000;

export type ProviderMachineProgress =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "refused"; message: string }
  | { status: "creating"; host: Host }
  | { status: "connected"; host: Host }
  | { status: "failed"; message: string; log: string };

function useProviderMachineCreation(providerId: string) {
  const creation = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (inputs: JsonValue | null) =>
      sdk.hosts.experimental_create({
        key: nanoid(),
        machineProviderId: providerId,
        inputs,
        wait: false,
      }),
  });
  const created = creation.data ?? null;
  const hostId = created?.id ?? null;
  const poll = useQuery({
    queryKey: ["machine-creation", hostId],
    enabled: hostId !== null,
    queryFn: ({ signal }) => sdk.hosts.get({ hostId: hostId!, signal }),
    refetchInterval: (query) =>
      query.state.data === undefined ||
      query.state.data.lifecycle.phase === "creating"
        ? POLL_MS
        : false,
    retry: false,
  });
  const host = created === null ? null : (poll.data ?? created);
  const progress: ProviderMachineProgress = creation.isPending
    ? { status: "starting" }
    : creation.isError
      ? {
          status: "refused",
          message: getMutationErrorMessage({
            error: creation.error,
            fallbackMessage: "Couldn't add the machine.",
          }),
        }
      : host === null
        ? { status: "idle" }
        : host.lifecycle.phase === "creating" && !poll.isError
          ? { status: "creating", host }
          : host.lifecycle.phase === "active"
            ? { status: "connected", host }
            : {
                status: "failed",
                message: host.lifecycle.message ?? "Machine setup stopped.",
                log: host.lifecycle.pendingLog,
              };
  return {
    progress,
    create: creation.mutate,
    reset: creation.reset,
    cancel() {
      if (hostId === null) return;
      void sdk.hosts.delete({ hostId }).catch(() => undefined);
      creation.reset();
    },
  };
}

export function ProviderMachineSetup({
  provider,
  chooser,
  onOpenChange,
}: {
  provider: SystemMachineProvider;
  chooser: ReactNode;
  onOpenChange: (open: boolean) => void;
}) {
  const inputs = useMachineProviderInputs({
    provider,
    instanceId: "add-machine",
  });
  const creation = useProviderMachineCreation(provider.id);
  return (
    <ProviderMachineSetupView
      description={provider.description}
      chooser={chooser}
      control={inputs.control}
      blockedReason={inputs.blockedReason}
      progress={creation.progress}
      onAdd={() => creation.create(inputs.value)}
      onBack={creation.reset}
      onCancel={creation.cancel}
      onOpenMachine={() => onOpenChange(false)}
    />
  );
}

export function ProviderMachineSetupView({
  description,
  chooser,
  control,
  blockedReason,
  progress,
  onAdd,
  onBack,
  onCancel,
  onOpenMachine,
}: {
  description: string;
  chooser: ReactNode;
  control: ReactNode;
  blockedReason: string | null;
  progress: ProviderMachineProgress;
  onAdd: () => void;
  onBack: () => void;
  onCancel: () => void;
  onOpenMachine: () => void;
}) {
  const editing =
    progress.status === "idle" ||
    progress.status === "starting" ||
    progress.status === "refused";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a machine</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {editing ? chooser : null}
      <div className={editing ? "space-y-3" : "hidden"}>
        {control}
        {progress.status === "refused" ? (
          <p role="alert" className="text-sm text-destructive-text">
            {progress.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {blockedReason === null ? null : (
            <p className="mr-auto text-xs text-subtle-foreground">
              {blockedReason}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={blockedReason !== null || progress.status === "starting"}
            onClick={onAdd}
          >
            {progress.status === "starting" ? "Adding..." : "Add machine"}
          </Button>
        </div>
      </div>
      {progress.status === "creating" ? (
        <>
          <MachineProgressLog
            log={progress.host.lifecycle.pendingLog}
            label="Setup log"
          />
          <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
            <Icon
              name="Spinner"
              className="size-4 shrink-0 animate-spin text-muted-foreground"
            />
            <span
              role="status"
              className="min-w-0 flex-1 text-sm text-muted-foreground"
            >
              {progress.host.lifecycle.message ?? "Adding the machine..."}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-subtle-foreground">
            You can close this window. The machine keeps being added and shows
            under Settings &gt; Machines.
          </p>
        </>
      ) : null}
      {progress.status === "failed" ? (
        <>
          <MachineProgressLog log={progress.log} label="Setup log" />
          <p
            role="alert"
            className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm text-destructive-text"
          >
            {progress.message}
          </p>
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={onBack}>
              Try again
            </Button>
          </div>
        </>
      ) : null}
      {progress.status === "connected" ? (
        <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
          <MachineStatusDot connected />
          <span
            role="status"
            className="min-w-0 flex-1 truncate text-sm text-foreground"
          >
            {progress.host.name} connected
          </span>
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
          >
            <Link
              to={getSettingsTargetPath({ machineId: progress.host.id })}
              onClick={onOpenMachine}
            >
              Open machine
              <Icon name="ArrowRight" />
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  );
}
