import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Thread } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Label } from "@bb/shared-ui/label";
import { RadioGroup, RadioGroupItem } from "@bb/shared-ui/radio-group";
import {
  useEnvironment,
  useProjectEnvironments,
} from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import {
  sidebarNavigationQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

export interface ThreadMoveTargetOption {
  environmentId: string;
  machineName: string;
  path: string;
  branchName: string | null;
}

interface ThreadMoveDialogContentProps {
  options: readonly ThreadMoveTargetOption[];
  loading: boolean;
  pending: boolean;
  error: string | null;
  onMove: (environmentId: string) => void;
  onCancel: () => void;
}

export function ThreadMoveDialogContent({
  options,
  loading,
  pending,
  error,
  onMove,
  onCancel,
}: ThreadMoveDialogContentProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (selectedId !== null && !pending) {
          onMove(selectedId);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Move to another machine</DialogTitle>
        <DialogDescription>
          The thread keeps its history, session and storage. Choose a ready
          environment on a different machine.
        </DialogDescription>
      </DialogHeader>
      {loading ? (
        <p role="status" className="text-sm text-subtle-foreground">
          Loading environments...
        </p>
      ) : options.length === 0 ? (
        <p role="status" className="text-sm text-subtle-foreground">
          This project has no ready environments on other machines.
        </p>
      ) : (
        <RadioGroup
          aria-label="Target environment"
          value={selectedId ?? ""}
          onValueChange={setSelectedId}
          disabled={pending}
        >
          {options.map((option) => (
            <Label
              key={option.environmentId}
              htmlFor={`thread-move-${option.environmentId}`}
              className="flex items-start gap-3 rounded-md border border-border p-3"
            >
              <RadioGroupItem
                id={`thread-move-${option.environmentId}`}
                value={option.environmentId}
                className="mt-0.5"
              />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-sm text-foreground">
                  {option.machineName}
                </span>
                <span className="break-all text-xs text-muted-foreground">
                  {option.path}
                </span>
                {option.branchName === null ? null : (
                  <span className="text-xs text-muted-foreground">
                    {option.branchName}
                  </span>
                )}
              </span>
            </Label>
          ))}
        </RadioGroup>
      )}
      {pending ? (
        <p role="status" className="text-sm text-subtle-foreground">
          Moving thread. This can take a while for large sessions...
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending || selectedId === null}>
          Move
        </Button>
      </DialogFooter>
    </form>
  );
}

interface ThreadMoveDialogProps {
  thread: Thread | null;
  onOpenChange: (open: boolean) => void;
}

export function ThreadMoveDialog({
  thread,
  onOpenChange,
}: ThreadMoveDialogProps) {
  return (
    <Dialog open={thread !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {thread ? (
          <ThreadMoveDialogBody thread={thread} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ThreadMoveDialogBody({
  thread,
  onOpenChange,
}: {
  thread: Thread;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const currentEnvironment = useEnvironment(thread.environmentId);
  const environments = useProjectEnvironments(thread.projectId);
  const hosts = useHosts();
  const [error, setError] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: async (environmentId: string) => {
      const result = await sdk.threads.experimental_move({
        threadId: thread.id,
        environmentId,
      });
      if (result.phase !== "done") {
        throw new Error(
          result.error ?? `The move ended in phase "${result.phase}".`,
        );
      }
      return result;
    },
    meta: { showErrorToast: false },
    onError: (moveError) =>
      setError(
        getMutationErrorMessage({
          error: moveError,
          fallbackMessage: "Failed to move thread.",
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: threadQueryKey(thread.id),
      });
      void queryClient.invalidateQueries({
        queryKey: sidebarNavigationQueryKey(),
      });
      onOpenChange(false);
    },
  });

  const hostNames = new Map(
    (hosts.data ?? []).map((host) => [host.id, host.name]),
  );
  const options: ThreadMoveTargetOption[] = [];
  for (const environment of environments.data ?? []) {
    const machineName = hostNames.get(environment.hostId);
    if (
      machineName === undefined ||
      environment.path === null ||
      environment.status !== "ready" ||
      environment.hostLifecycle !== "active" ||
      environment.hostId === currentEnvironment.data?.hostId
    ) {
      continue;
    }
    options.push({
      environmentId: environment.id,
      machineName,
      path: environment.path,
      branchName: environment.branchName,
    });
  }

  return (
    <ThreadMoveDialogContent
      options={options}
      loading={
        environments.isPending ||
        hosts.isPending ||
        (thread.environmentId !== null && currentEnvironment.isPending)
      }
      pending={move.isPending}
      error={error}
      onMove={(environmentId) => {
        setError(null);
        move.mutate(environmentId);
      }}
      onCancel={() => onOpenChange(false)}
    />
  );
}
