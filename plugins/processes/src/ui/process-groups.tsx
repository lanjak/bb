import { useEffect, useState } from "react";
import type { ProcessRow } from "../../contract.js";
import { formatBytes, formatDuration, formatPercent } from "../format.js";
import { StopButton } from "./stop-button.js";

export interface ProcessGroup {
  key: string;
  rootPid: number | null;
  rows: ProcessRow[];
}

export function groupProcesses(rows: readonly ProcessRow[]): ProcessGroup[] {
  const groups = new Map<number | null, ProcessRow[]>();
  for (const row of rows) {
    const group = groups.get(row.rootPid) ?? [];
    group.push(row);
    groups.set(row.rootPid, group);
  }
  return [...groups.entries()]
    .map(([rootPid, members]) => ({
      key: rootPid === null ? "agent" : String(rootPid),
      rootPid,
      rows: [...members].sort(
        (left, right) =>
          Number(right.pid === rootPid) - Number(left.pid === rootPid) ||
          (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0) ||
          right.rssBytes - left.rssBytes,
      ),
    }))
    .sort((left, right) => {
      if (left.rootPid === null) return 1;
      if (right.rootPid === null) return -1;
      const weigh = (group: ProcessGroup) =>
        group.rows.reduce((sum, row) => sum + row.rssBytes, 0);
      return weigh(right) - weigh(left);
    });
}

const ROLE_LABELS = {
  agent: "agent",
  command: "command",
  server: "server",
} as const;

function ProcessLine({
  row,
  threadId,
  now,
  nested,
  compact,
}: {
  row: ProcessRow;
  threadId: string;
  now: number;
  nested: boolean;
  compact: boolean;
}) {
  const ports = row.ports.map((port) => `:${port.port}`).join(" ");
  const age =
    row.startedAt === null ? null : formatDuration(now - row.startedAt);
  return (
    <li
      className={`flex min-h-7 list-none items-center gap-2 text-xs ${nested ? "pl-4" : ""}`}
    >
      <span
        className="min-w-0 flex-1 truncate text-foreground"
        title={row.command ?? row.name}
      >
        {row.name}
        <span className="ml-1.5 tabular-nums text-subtle-foreground">
          {row.pid}
        </span>
        {ports === "" ? null : (
          <span className="ml-1.5 tabular-nums text-muted-foreground">
            {ports}
          </span>
        )}
      </span>
      {compact ? null : (
        <span className="shrink-0 text-subtle-foreground max-sm:hidden">
          {ROLE_LABELS[row.role]}
          {age === null ? "" : ` · ${age}`}
        </span>
      )}
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
        {row.cpuPercent === null ? "-" : formatPercent(row.cpuPercent)}
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
        {formatBytes(row.rssBytes)}
      </span>
      <span className="flex w-24 shrink-0 justify-end">
        {row.stoppable ? <StopButton threadId={threadId} row={row} /> : null}
      </span>
    </li>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ProcessGroups({
  rows,
  threadId,
  compact = false,
}: {
  rows: readonly ProcessRow[];
  threadId: string;
  compact?: boolean;
}) {
  const now = useNow();
  return (
    <ul className="m-0 flex flex-col p-0">
      {groupProcesses(rows).map((group) => (
        <li key={group.key} className="list-none">
          <ul className="m-0 flex flex-col p-0">
            {group.rows.map((row) => (
              <ProcessLine
                key={row.pid}
                row={row}
                threadId={threadId}
                now={now}
                nested={row.pid !== group.rootPid && group.rootPid !== null}
                compact={compact}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
