import {
  experimental_InfoSection as InfoSection,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { formatBytes, formatPercent, plain } from "../format.js";
import { useThreadUsage } from "./hooks.js";
import { ProcessGroups } from "./process-groups.js";

export function ThreadProcessesSection({
  threadId,
}: ExperimentalThreadInfoProps) {
  const query = useThreadUsage(threadId);
  const result = query.data;
  if (result === undefined || result.status === "no-environment") return null;
  if (result.usage === null)
    return (
      <InfoSection label="Processes">
        <p className="m-0 px-3 pb-2 text-xs text-muted-foreground">
          {plain(result.reason ?? "")}
        </p>
      </InfoSection>
    );
  const { usage } = result;
  return (
    <InfoSection label="Processes" count={usage.processCount}>
      <div className="flex flex-col gap-1 px-3 pb-2">
        <p className="m-0 text-xs text-muted-foreground">
          {formatPercent(usage.cpuPercent)} CPU · {formatBytes(usage.rssBytes)}{" "}
          memory
          {result.hostName === null ? "" : ` on ${plain(result.hostName)}`}
        </p>
        {usage.processes.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            No process of this thread is running.
          </p>
        ) : (
          <ProcessGroups rows={usage.processes} threadId={threadId} />
        )}
      </div>
    </InfoSection>
  );
}
