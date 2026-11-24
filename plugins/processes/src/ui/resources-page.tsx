import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type {
  MachineUsage,
  MachineView,
  ThreadUsage,
  UsageStatus,
} from "../../contract.js";
import { formatBytes, formatPercent, plain } from "../format.js";
import { useMachineUsage, useMachines } from "./hooks.js";
import { ProcessGroups } from "./process-groups.js";

const TONE: Record<UsageStatus, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive",
};

const STATUS_TEXT: Record<UsageStatus, string> = {
  ok: "text-muted-foreground",
  warning: "text-warning-text",
  critical: "text-destructive-text",
};

export function Meter({
  label,
  title,
  percent,
  status,
  detail,
}: {
  label: string;
  title?: string;
  percent: number | null;
  status: UsageStatus;
  detail: string;
}) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="flex min-w-0 flex-col gap-1" title={title}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 whitespace-nowrap tabular-nums text-foreground">
          {detail}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(width)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${TONE[status]}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export function StatusChip({ machine }: { machine: MachineView }) {
  if (!machine.online)
    return <span className="text-xs text-subtle-foreground">Offline</span>;
  return (
    <span
      className={`text-xs ${STATUS_TEXT[machine.status]}`}
      title={machine.reasons.join("; ")}
    >
      {machine.status === "ok"
        ? "OK"
        : `${machine.status === "critical" ? "Critical" : "Warning"}: ${machine.reasons[0] ?? ""}`}
    </span>
  );
}

function MachineMeters({ machine }: { machine: MachineView }) {
  if (!machine.online || machine.memory === null) {
    return machine.reasons.length > 0 ? (
      <p className="m-0 text-xs text-muted-foreground">{machine.reasons[0]}</p>
    ) : null;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Meter
        label="CPU"
        percent={machine.cpuPercent}
        status={machine.cpuStatus}
        detail={
          machine.cpuPercent === null
            ? "measuring"
            : `${formatPercent(machine.cpuPercent)} (${machine.cpuCount ?? "?"} cores)`
        }
      />
      <Meter
        label="Memory"
        percent={machine.memory.percent}
        status={machine.memory.status}
        detail={`${formatBytes(machine.memory.usedBytes)} of ${formatBytes(machine.memory.totalBytes)}`}
      />
      {machine.disks.map((disk) => (
        <Meter
          key={disk.path}
          label={`Disk ${plain(disk.label)}`}
          title={disk.path}
          percent={100 - disk.freePercent}
          status={disk.status}
          detail={`${formatBytes(disk.freeBytes)} free`}
        />
      ))}
    </div>
  );
}

function ThreadRow({ thread }: { thread: ThreadUsage }) {
  const [open, setOpen] = useState(false);
  const navigate = useBbNavigate();
  return (
    <li className="list-none border-t border-border-hairline first:border-t-0">
      <div className="flex min-h-8 items-center gap-2 text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded bg-transparent px-1 py-1 text-left hover:bg-state-hover"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="w-3 shrink-0 text-subtle-foreground">
            {open ? "-" : "+"}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {plain(thread.title)}
          </span>
        </button>
        <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
          {formatPercent(thread.cpuPercent)}
        </span>
        <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
          {formatBytes(thread.rssBytes)}
        </span>
        <span className="w-14 shrink-0 text-right tabular-nums text-subtle-foreground max-sm:hidden">
          {thread.processCount} proc
        </span>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label={`Open thread ${plain(thread.title)}`}
          onClick={() => navigate.toThread(thread.threadId)}
        >
          Open
        </button>
      </div>
      {open ? (
        <div className="pb-2 pl-5">
          <ProcessGroups rows={thread.processes} threadId={thread.threadId} />
        </div>
      ) : null}
    </li>
  );
}

function ThreadsTable({ usage }: { usage: MachineUsage }) {
  if (!usage.threadsSupported)
    return (
      <p className="m-0 text-xs text-muted-foreground">
        Threads: {usage.threadsReason ?? "not available on this machine."}
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {usage.threads.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          No thread is running processes on this machine.
        </p>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 px-1 pb-1 text-2xs uppercase tracking-wide text-subtle-foreground">
            <span className="flex-1">Thread</span>
            <span className="w-12 text-right">CPU</span>
            <span className="w-16 text-right">Memory</span>
            <span className="w-14 text-right max-sm:hidden">Procs</span>
            <span className="w-11" />
          </div>
          <ul className="m-0 flex flex-col p-0">
            {usage.threads.map((thread) => (
              <ThreadRow key={thread.threadId} thread={thread} />
            ))}
          </ul>
        </div>
      )}
      {usage.otherBb.processCount > 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          Other bb processes: {usage.otherBb.processCount} using{" "}
          {formatPercent(usage.otherBb.cpuPercent)} and{" "}
          {formatBytes(usage.otherBb.rssBytes)}. They belong to threads this
          server does not know.
        </p>
      ) : null}
    </div>
  );
}

function OtherProcesses({ usage }: { usage: MachineUsage }) {
  if (usage.others.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="m-0 text-xs font-medium text-muted-foreground">
        Top other processes
      </h4>
      <ul className="m-0 flex flex-col p-0">
        {usage.others.map((other) => (
          <li
            key={`${other.pid}:${other.startToken}`}
            className="flex min-h-6 list-none items-center gap-2 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-foreground">
              {plain(other.name)}
              <span className="ml-1.5 tabular-nums text-subtle-foreground">
                {other.pid}
              </span>
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
              {other.cpuPercent === null
                ? "-"
                : formatPercent(other.cpuPercent)}
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
              {formatBytes(other.rssBytes)}
            </span>
            <span className="w-14 shrink-0 max-sm:hidden" />
            <span className="w-11 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function MachineDetails({ hostId }: { hostId: string }) {
  const query = useMachineUsage(hostId);
  if (query.data === undefined)
    return (
      <p className="m-0 text-xs text-muted-foreground">Reading processes...</p>
    );
  return (
    <div className="flex flex-col gap-4">
      <ThreadsTable usage={query.data} />
      <OtherProcesses usage={query.data} />
    </div>
  );
}

function MachineSection({ machine }: { machine: MachineView }) {
  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
      aria-label={`Machine ${machine.name}`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 truncate text-sm font-medium text-foreground">
          {machine.name}
        </h3>
        <StatusChip machine={machine} />
      </header>
      <MachineMeters machine={machine} />
      {machine.online ? <MachineDetails hostId={machine.hostId} /> : null}
    </section>
  );
}

export function ResourcesPanel() {
  const query = useMachines();
  const machines = query.data?.machines ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {query.data === undefined ? (
          <p className="m-0 text-sm text-muted-foreground">
            Reading machines...
          </p>
        ) : machines.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            No machine is connected.
          </p>
        ) : (
          machines.map((machine) => (
            <MachineSection key={machine.hostId} machine={machine} />
          ))
        )}
        <p className="m-0 text-2xs text-subtle-foreground">
          Memory counts shared pages once for each process, so a thread's total
          can exceed what it really uses. Samples are not stored.
        </p>
      </div>
    </div>
  );
}
