import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@bb/shared-ui/icon";
import {
  AnimatedDisclosureBody,
  SectionToggleButton,
} from "@bb/shared-ui/prompt-stack-disclosure";
import {
  definePluginApp,
  experimental_THREAD_INFO_SECTION_GROUPS,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { processesContract, type HostDevServer } from "./contract.js";
import { useResourcesBadge } from "./src/ui/badge.js";
import { ResourcesPanel } from "./src/ui/resources-page.js";
import { ThreadProcessesSection } from "./src/ui/thread-processes.js";

const REFRESH_MS = 15_000;
const TOGGLE_ID = "thread-prompt-banner-processes-toggle";
const BODY_ID = "thread-prompt-banner-processes-body";
const SEGMENT_GROUP = "4_devServers";

export function useDevServers(threadId: string): HostDevServer[] {
  const query = experimental_useRpcQuery({
    contract: processesContract,
    method: "servers.list",
    input: { threadId },
  });
  return query.data?.servers ?? [];
}

function useRefreshingDevServers(threadId: string): HostDevServer[] {
  const query = experimental_useRpcQuery({
    contract: processesContract,
    method: "servers.list",
    input: { threadId },
  });
  const { refetch } = query;
  useEffect(() => {
    const timer = setInterval(() => void refetch(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  return query.data?.servers ?? [];
}

export function portLabel(port: number, mappedTo: number | undefined): string {
  return mappedTo === undefined || mappedTo === port
    ? `:${port}`
    : `${port} -> localhost:${mappedTo}`;
}

export function forwardCommand(server: HostDevServer, port: number): string {
  return `bb machine forward ${port} --machine ${server.hostId}`;
}

export function describeCommand(command: string | null): string {
  if (command === null) return "Unknown command";
  return command.length > 80 ? `${command.slice(0, 77)}...` : command;
}

export function summaryLabel(servers: readonly HostDevServer[]): string {
  const ports = servers.flatMap((server) =>
    server.ports.map((port) => port.port),
  );
  const shown = ports
    .slice(0, 3)
    .map((port) => `:${port}`)
    .join(" ");
  const more = ports.length > 3 ? ` +${ports.length - 3}` : "";
  return `${servers.length === 1 ? "1 server" : `${servers.length} servers`} · ${shown}${more}`;
}

function ServerRow({
  server,
  threadId,
}: {
  server: HostDevServer;
  threadId: string;
}) {
  const navigate = useBbNavigate();
  const stop = experimental_useRpcMutation({
    contract: processesContract,
    method: "processes.stop",
  });
  const open = experimental_useRpcMutation({
    contract: processesContract,
    method: "servers.open",
  });
  const [mappings, setMappings] = useState<Record<number, number>>({});
  const [notice, setNotice] = useState<{ port: number; reason: string } | null>(
    null,
  );
  const [shared, setShared] = useState<{ port: number; url: string } | null>(
    null,
  );
  const ports = server.ports.map((port) => `:${port.port}`).join(" ");

  async function openPort(port: number, target: "bb-browser" | "external") {
    setNotice(null);
    setShared(null);
    const result = await navigate.experimental_openHostPort({
      hostId: server.hostId,
      port,
      target,
    });
    if (result.via === "forward") {
      setMappings((current) => ({ ...current, [port]: result.localPort }));
      return;
    }
    if (result.via === "local") return;
    const share = await open.mutate({
      threadId,
      hostId: server.hostId,
      port,
    });
    if (share.status === "ok") {
      setShared({ port, url: share.url });
      navigate.openUrl(share.url);
      return;
    }
    setNotice({ port, reason: share.reason });
  }

  function report(error: unknown, port: number) {
    toast.error(
      error instanceof Error
        ? error.message
        : `Could not open :${port} on ${server.hostName}.`,
    );
  }

  return (
    <li className="flex list-none flex-col gap-0.5 text-xs">
      <div className="flex min-h-7 items-center gap-2">
        <span className="flex shrink-0 items-center gap-1">
          {server.ports.map((port) => (
            <button
              key={`${port.address}:${port.port}`}
              type="button"
              className="shrink-0 cursor-pointer rounded bg-muted px-1.5 py-0.5 font-medium tabular-nums text-foreground hover:bg-state-hover"
              aria-label={`Open ${portLabel(port.port, mappings[port.port])} on ${server.hostName}`}
              title={`Open ${port.address}:${port.port} on ${server.hostName}`}
              onClick={() => {
                openPort(port.port, "bb-browser").catch((error: unknown) =>
                  report(error, port.port),
                );
              }}
            >
              {portLabel(port.port, mappings[port.port])}
            </button>
          ))}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={server.command ?? undefined}
        >
          {describeCommand(server.command)}
        </span>
        <span className="shrink-0 text-subtle-foreground">
          {server.hostName}
        </span>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label={`Open the first port of ${server.hostName} in the system browser`}
          onClick={() => {
            const first = server.ports[0]!.port;
            openPort(first, "external").catch((error: unknown) =>
              report(error, first),
            );
          }}
        >
          External
        </button>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-50"
          aria-label={`Stop the server on ${ports}`}
          disabled={stop.isPending}
          onClick={() => {
            stop
              .mutate({
                threadId,
                rootPid: server.rootPid,
                startToken: server.startToken,
              })
              .then(({ outcome }) => {
                if (outcome !== "stopped")
                  toast.error(
                    `The server on ${ports} was not stopped: ${outcome}.`,
                  );
              })
              .catch((error: unknown) => {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : `Failed to stop the server on ${ports}.`,
                );
              });
          }}
        >
          Stop
        </button>
      </div>
      {shared === null ? null : (
        <p role="status" className="m-0 pb-1 pl-1 text-muted-foreground">
          <a
            className="rounded text-foreground underline hover:bg-state-hover"
            href={shared.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the bb Connect share of :{shared.port}
          </a>{" "}
          if no new tab opened.
        </p>
      )}
      {notice === null ? null : (
        <p
          role="status"
          className="m-0 flex flex-wrap items-center gap-x-2 pb-1 pl-1 text-muted-foreground"
        >
          <span>{notice.reason}</span>
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 text-foreground hover:bg-state-hover"
            onClick={() => {
              void navigator.clipboard?.writeText(
                forwardCommand(server, notice.port),
              );
            }}
          >
            Copy command
          </button>
        </p>
      )}
    </li>
  );
}

export function DevServersSummary({
  threadId,
  segments,
  isExpanded,
  onToggle,
}: ExperimentalThreadContextSegmentProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const servers = useDevServers(threadId);
  if (servers.length === 0) return null;
  const label = summaryLabel(servers);
  return (
    <SectionToggleButton
      buttonRef={buttonRef}
      fillRow
      id={TOGGLE_ID}
      controlsId={BODY_ID}
      icon={
        <Icon name="Globe" className="size-3.5 shrink-0" aria-hidden="true" />
      }
      label={label}
      compactLabel={
        servers.length === 1 ? "1 server" : `${servers.length} servers`
      }
      hideLabelInCompact={segments.length > 2}
      ariaLabel={`Servers: ${label}`}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
}

export function DevServersDetails({
  threadId,
  isExpanded,
  onToggle,
}: ExperimentalThreadContextSegmentProps) {
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const servers = useDevServers(threadId);
  if (servers.length === 0) return null;
  return (
    <AnimatedDisclosureBody
      collapsedBorder="reserve"
      id={BODY_ID}
      labelledBy={TOGGLE_ID}
      isExpanded={isExpanded}
      collapseLabel="Collapse servers"
      collapseRef={collapseRef}
      onCollapse={onToggle}
    >
      <ul className="max-h-48 overflow-y-auto px-3 pb-2 pt-1">
        {servers.map((server) => (
          <ServerRow
            key={`${server.hostId}:${server.rootPid}`}
            server={server}
            threadId={threadId}
          />
        ))}
      </ul>
    </AnimatedDisclosureBody>
  );
}

function useDevServersVisible({
  threadId,
}: ExperimentalThreadContextSegmentInput): boolean {
  return useRefreshingDevServers(threadId).length > 0;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "resources",
    title: "Resources",
    icon: "ChartColumn",
    path: "resources",
    component: ResourcesPanel,
    experimental_useBadge: useResourcesBadge,
  });
  app.slots.experimental_threadInfoSection({
    id: "processes",
    group: experimental_THREAD_INFO_SECTION_GROUPS.related,
    order: 10,
    component: ThreadProcessesSection,
  });
  app.slots.experimental_threadContextSegment({
    id: "servers",
    title: "Servers",
    group: SEGMENT_GROUP,
    order: 10,
    summary: DevServersSummary,
    details: DevServersDetails,
    useVisible: useDevServersVisible,
  });
});
