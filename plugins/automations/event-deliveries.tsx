import { useEffect, useState } from "react";
import type {
  AutomationEventDetail,
  AutomationEventSummary,
  AutomationRunResponse,
} from "./src/rpc-types";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Pill } from "@/components/ui/pill";
import { ResourceDetailCollection } from "@/components/ui/resource-list";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EVENT_OUTCOME_LABELS, type OutcomeTone } from "./lib/format-event";
import { formatScheduleRunTime } from "./lib/format-schedule";

export interface AutomationEventsViewState {
  events: readonly AutomationEventSummary[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  retry: () => void;
}

const OUTCOME_PILL: Record<
  OutcomeTone,
  "secondary" | "outline" | "destructive"
> = {
  active: "secondary",
  quiet: "outline",
  problem: "destructive",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DeliveryDetail({
  deliveryId,
  loadDetail,
}: {
  deliveryId: string;
  loadDetail: (deliveryId: string) => Promise<AutomationEventDetail>;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: AutomationEventDetail }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    loadDetail(deliveryId).then(
      (detail) => {
        if (!cancelled) setState({ kind: "ready", detail });
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: errorText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deliveryId, loadDetail]);
  if (state.kind === "loading") {
    return (
      <div className="px-2 pb-2">
        <Skeleton className="h-16 w-full rounded-md" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="px-2 pb-2 text-xs text-destructive">
        The delivery could not be read: {state.message}
      </p>
    );
  }
  const { detail } = state;
  return (
    <div data-event-delivery-detail="" className="grid min-w-0 gap-2 px-2 pb-2">
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          Payload
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-recessed/70 px-3 py-2 font-mono text-xs leading-relaxed">
          {detail.payload === null
            ? `Too large to keep (${detail.payloadBytes} bytes)`
            : JSON.stringify(detail.payload, null, 2)}
        </pre>
      </div>
      {detail.promptPreviews.map((preview) => (
        <div key={preview.automationId}>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Prompt the agent gets
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-recessed/70 px-3 py-2 font-mono text-xs leading-relaxed">
            {preview.prompt}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function EventDeliveryRow({
  event,
  automationId,
  run,
  loadDetail,
  onOpenThread,
}: {
  event: AutomationEventSummary;
  automationId: string;
  run: AutomationRunResponse | undefined;
  loadDetail: (deliveryId: string) => Promise<AutomationEventDetail>;
  onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const outcome = event.outcomes.find(
    (entry) => entry.automationId === automationId,
  );
  const label = outcome ? EVENT_OUTCOME_LABELS[outcome.outcome] : null;
  const threadId = run?.threadId ?? null;
  return (
    <div className="overflow-hidden rounded-sm" data-event-delivery="">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="group/delivery flex min-w-0 flex-1 items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon
            name="ChevronRight"
            className={cn(
              "size-3.5 shrink-0 text-subtle-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="w-28 shrink-0 text-sm text-foreground">
            {formatScheduleRunTime(event.receivedAt)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {event.kind}
          </span>
          {event.sample ? (
            <Pill variant="outline" size="sm">
              Sample
            </Pill>
          ) : null}
          {label === null ? null : (
            <span title={outcome?.reason ?? undefined} className="shrink-0">
              <Pill variant={OUTCOME_PILL[label.tone]} size="sm">
                {label.label}
              </Pill>
            </span>
          )}
        </button>
        <div className="flex size-8 shrink-0 items-center justify-center">
          {threadId === null ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Open the thread of this delivery"
              onClick={() => onOpenThread(threadId)}
            >
              <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {outcome?.reason ? (
        <p className="px-2 pb-1.5 pl-9 text-xs text-subtle-foreground">
          {outcome.reason}
        </p>
      ) : null}
      {open ? (
        <DeliveryDetail deliveryId={event.id} loadDetail={loadDetail} />
      ) : null}
    </div>
  );
}

export function EventDeliveriesList({
  state,
  automationId,
  runs,
  loadDetail,
  onOpenThread,
}: {
  state: AutomationEventsViewState;
  automationId: string;
  runs: readonly AutomationRunResponse[];
  loadDetail: (deliveryId: string) => Promise<AutomationEventDetail>;
  onOpenThread: (threadId: string) => void;
}) {
  if (state.error !== null) {
    return (
      <ResourceDetailCollection>
        <div
          data-event-deliveries-state="error"
          className="flex min-w-0 items-center justify-between gap-3 px-2 py-1.5 text-left text-sm"
        >
          <span className="py-1.5 text-muted-foreground">
            Deliveries unavailable.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={state.retry}
          >
            Retry
          </Button>
        </div>
      </ResourceDetailCollection>
    );
  }
  if (state.loading) {
    return (
      <DelayedLoading>
        <ResourceDetailCollection>
          <div
            data-event-deliveries-state="loading"
            role="status"
            aria-label="Loading deliveries"
            className="flex min-w-0 items-center gap-2.5 px-2 py-2.5"
          >
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="h-3 w-28 rounded-sm" />
            <Skeleton className="h-3 w-10 rounded-sm" />
          </div>
        </ResourceDetailCollection>
      </DelayedLoading>
    );
  }
  if (state.events.length === 0) {
    return (
      <ResourceDetailCollection>
        <div
          data-event-deliveries-state="empty"
          className="px-2 py-3 text-center text-sm text-muted-foreground"
        >
          No deliveries yet. Send a test event, or point your sender at the URL
          above.
        </div>
      </ResourceDetailCollection>
    );
  }
  return (
    <div>
      <ResourceDetailCollection className="divide-border/60">
        {state.events.map((event) => (
          <EventDeliveryRow
            key={event.id}
            event={event}
            automationId={automationId}
            run={runs.find(
              (candidate) => candidate.eventDeliveryId === event.id,
            )}
            loadDetail={loadDetail}
            onOpenThread={onOpenThread}
          />
        ))}
      </ResourceDetailCollection>
      {state.nextCursor !== null ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={state.loadingMore}
            onClick={state.loadMore}
          >
            {state.loadingMore ? "Loading" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
