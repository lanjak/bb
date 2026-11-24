import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  AutomationEventTrigger,
  AutomationHookResponse,
  AutomationHookSecretResponse,
  HookTestResponse,
  PermissionMode,
} from "./src/rpc-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  EVENT_OUTCOME_LABELS,
  formatHookUrlSource,
  formatHookVerification,
  formatSourceName,
  formatWhereClause,
  parseSamplePayload,
  type JsonValue,
} from "./lib/format-event";
import { formatScheduleRunTime } from "./lib/format-schedule";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COPIED_FEEDBACK_MS = 2000;

export function CopyValueButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(
      () => setCopied(false),
      COPIED_FEEDBACK_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 shrink-0 text-muted-foreground"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      <Icon name={copied ? "Check" : "Copy"} className="size-3.5" aria-hidden />
    </Button>
  );
}

function CardRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-1 px-3.5 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3",
        className,
      )}
    >
      <div className="pt-0.5 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 text-sm text-foreground">{children}</div>
    </div>
  );
}

function MonoChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
      <span className="truncate">{children}</span>
    </span>
  );
}

function WarningNote({
  icon,
  children,
  dataAttribute,
}: {
  icon: "AlertTriangle" | "Info";
  children: ReactNode;
  dataAttribute: string;
}) {
  return (
    <div
      {...{ [dataAttribute]: "" }}
      className="flex min-w-0 items-start gap-2 bg-warning/10 px-3.5 py-2.5 text-xs leading-relaxed text-warning-text"
    >
      <Icon name={icon} className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SecretRevealDialog({
  open,
  hookName,
  reveal,
  onClose,
}: {
  open: boolean;
  hookName: string;
  reveal: AutomationHookSecretResponse | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        {reveal !== null ? (
          <>
            <DialogHeader>
              <DialogTitle>New secret for {hookName}</DialogTitle>
              <DialogDescription>
                Copy it now. It is not shown again. The old secret already
                stopped working, so update the sender.
              </DialogDescription>
            </DialogHeader>
            <div
              data-event-secret=""
              className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-recessed/70 px-3 py-2"
            >
              <code className="min-w-0 flex-1 break-all font-mono text-xs">
                {reveal.secret}
              </code>
              <CopyValueButton value={reveal.secret} label="Copy secret" />
            </div>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RotateConfirmDialog({
  open,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onCancel())}
    >
      <DialogContent>
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle>Rotate the secret?</DialogTitle>
              <DialogDescription>
                The current secret stops working at once. Every sender that
                still uses it gets a 401 until you give it the new one.
              </DialogDescription>
            </DialogHeader>
            {error !== null ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button type="button" disabled={pending} onClick={onConfirm}>
                Rotate secret
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const SAMPLE_PAYLOAD_PLACEHOLDER = '{"hello": "world"}';

function TestEventDialog({
  open,
  source,
  onTest,
  onClose,
}: {
  open: boolean;
  source: AutomationHookResponse["source"];
  onTest: (input: {
    payload: JsonValue;
    kind: string | null;
    send: boolean;
  }) => Promise<HookTestResponse>;
  onClose: () => void;
}) {
  const [payloadText, setPayloadText] = useState("");
  const [kind, setKind] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HookTestResponse | null>(null);

  const run = (send: boolean) => {
    const parsed = parseSamplePayload(payloadText);
    if (!parsed.ok) {
      setError(`The payload is not valid JSON: ${parsed.error}`);
      return;
    }
    setPending(true);
    setError(null);
    onTest({
      payload: parsed.value,
      kind: kind.trim() === "" ? null : kind.trim(),
      send,
    })
      .then(setResult, (rpcError: unknown) => setError(errorText(rpcError)))
      .finally(() => setPending(false));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle>Send a test event</DialogTitle>
              <DialogDescription>
                Runs the same filters as a real delivery, without a signature.
                Preview shows the prompt the agent would get and stores nothing.
                Send stores a sample delivery and starts a real run.
              </DialogDescription>
            </DialogHeader>
            <div className="grid min-w-0 gap-3">
              <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                Event kind
                <Input
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  placeholder={source === "github" ? "issues.labeled" : "call"}
                  className="font-mono text-sm"
                  disabled={pending}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                Payload (JSON)
                <Textarea
                  value={payloadText}
                  onChange={(event) => setPayloadText(event.target.value)}
                  placeholder={SAMPLE_PAYLOAD_PLACEHOLDER}
                  className="min-h-28 font-mono text-xs"
                  disabled={pending}
                />
              </label>
              {error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {result !== null ? (
                <div data-event-test-result="" className="grid min-w-0 gap-2">
                  <ul className="grid gap-1 text-sm">
                    {result.outcomes.length === 0 ? (
                      <li className="text-muted-foreground">
                        No automation listens on this hook.
                      </li>
                    ) : (
                      result.outcomes.map((outcome) => (
                        <li key={outcome.automationId}>
                          <span className="font-medium">
                            {EVENT_OUTCOME_LABELS[outcome.outcome].label}
                          </span>
                          {outcome.reason === null ? null : (
                            <span className="text-muted-foreground">
                              {" "}
                              ({outcome.reason})
                            </span>
                          )}
                        </li>
                      ))
                    )}
                  </ul>
                  {result.promptPreviews.map((preview) => (
                    <pre
                      key={preview.automationId}
                      data-event-prompt-preview=""
                      className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-recessed/70 px-3 py-2 font-mono text-xs leading-relaxed"
                    >
                      {preview.prompt}
                    </pre>
                  ))}
                  {!result.dryRun ? (
                    <p className="text-xs text-muted-foreground">
                      Stored as a sample delivery. Matching automations are
                      starting.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={onClose}
              >
                Close
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => run(false)}
              >
                Preview prompt
              </Button>
              <Button
                type="button"
                disabled={pending}
                onClick={() => run(true)}
              >
                Send sample
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface EventTriggerCardProps {
  trigger: AutomationEventTrigger;
  permissionMode: PermissionMode | null;
  hook: AutomationHookResponse | null;
  hookError: string | null;
  disabled: boolean;
  onRotate: () => Promise<AutomationHookSecretResponse>;
  onTest: (input: {
    payload: JsonValue;
    kind: string | null;
    send: boolean;
  }) => Promise<HookTestResponse>;
}

export function EventTriggerCard({
  trigger,
  permissionMode,
  hook,
  hookError,
  disabled,
  onRotate,
  onTest,
}: EventTriggerCardProps) {
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<AutomationHookSecretResponse | null>(
    null,
  );
  const [testOpen, setTestOpen] = useState(false);

  const confirmRotate = () => {
    setRotating(true);
    setRotateError(null);
    onRotate()
      .then(
        (result) => {
          setRotateOpen(false);
          setReveal(result);
        },
        (rpcError: unknown) => setRotateError(errorText(rpcError)),
      )
      .finally(() => setRotating(false));
  };

  const fullAccess = permissionMode === "full";

  return (
    <div
      data-event-trigger-card=""
      className="overflow-hidden rounded-xl border border-border bg-surface-recessed/55"
    >
      {hook === null ? (
        <div className="px-3.5 py-3 text-sm text-muted-foreground">
          {hookError === null
            ? "Loading the webhook URL"
            : `The hook could not be read: ${hookError}`}
        </div>
      ) : (
        <div className="divide-y divide-border/70">
          <CardRow label={`${formatSourceName(hook.source)} URL`}>
            <div className="flex min-w-0 items-center gap-2">
              <code
                data-event-url=""
                className="min-w-0 flex-1 break-all font-mono text-xs"
              >
                {hook.url}
              </code>
              <CopyValueButton value={hook.url} label="Copy webhook URL" />
            </div>
            <p
              data-event-url-source=""
              className="mt-1 text-xs text-muted-foreground"
            >
              {formatHookUrlSource(hook.urlSource)}
            </p>
          </CardRow>
          <WarningNote
            icon={hook.urlScope === "public" ? "Info" : "AlertTriangle"}
            dataAttribute="data-event-url-warning"
          >
            {hook.urlWarning}
          </WarningNote>
          <CardRow label="Verification">
            <p>{formatHookVerification(hook)}</p>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                Secret version {hook.secretVersion}
                {hook.rotatedAt === null
                  ? ""
                  : `, rotated ${formatScheduleRunTime(hook.rotatedAt)}`}
              </span>
              {hook.rejectedCount > 0 ? (
                <span data-event-rejected="">
                  {hook.rejectedCount} rejected request
                  {hook.rejectedCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </CardRow>
          <CardRow label="Events">
            {trigger.events.length === 0 ? (
              <span className="text-muted-foreground">Every event kind</span>
            ) : (
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {trigger.events.map((kind) => (
                  <MonoChip key={kind}>{kind}</MonoChip>
                ))}
              </div>
            )}
          </CardRow>
          <CardRow label="Filters">
            {trigger.where.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <ul className="grid min-w-0 gap-1">
                {trigger.where.map((clause) => (
                  <li key={formatWhereClause(clause)} className="min-w-0">
                    <MonoChip>{formatWhereClause(clause)}</MonoChip>
                  </li>
                ))}
              </ul>
            )}
          </CardRow>
          <CardRow label="Shown to agent">
            {trigger.pick.length === 0 ? (
              <span className="text-muted-foreground">
                The whole payload, up to {trigger.maxPayloadBytes} bytes
              </span>
            ) : (
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {trigger.pick.map((path) => (
                  <MonoChip key={path}>{path}</MonoChip>
                ))}
              </div>
            )}
          </CardRow>
          <CardRow label="Run cap">
            {trigger.maxRunsPerHour} runs per hour. Failed events are not run
            again by Automations.
          </CardRow>
          {fullAccess ? (
            <WarningNote
              icon="AlertTriangle"
              dataAttribute="data-event-full-access"
            >
              Full access is on. Anyone who can cause this event, or who wrote
              text in it, can steer an unattended agent with full access
              {trigger.acknowledgeUntrustedInput
                ? " (acknowledged)."
                : ". It is not acknowledged, so the next save will fail."}
            </WarningNote>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2 px-3.5 py-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setTestOpen(true)}
            >
              <Icon name="Play" className="size-3.5" aria-hidden />
              Send test event
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setRotateError(null);
                setRotateOpen(true);
              }}
            >
              <Icon name="RotateCcw" className="size-3.5" aria-hidden />
              Rotate secret
            </Button>
          </div>
        </div>
      )}
      <RotateConfirmDialog
        open={rotateOpen}
        pending={rotating}
        error={rotateError}
        onConfirm={confirmRotate}
        onCancel={() => (rotating ? undefined : setRotateOpen(false))}
      />
      <SecretRevealDialog
        open={reveal !== null}
        hookName={hook?.name ?? ""}
        reveal={reveal}
        onClose={() => setReveal(null)}
      />
      <TestEventDialog
        open={testOpen}
        source={hook?.source ?? "webhook"}
        onTest={onTest}
        onClose={() => setTestOpen(false)}
      />
    </div>
  );
}
