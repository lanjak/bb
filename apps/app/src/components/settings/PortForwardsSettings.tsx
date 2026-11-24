import { useEffect, useState } from "react";
import type { BbDesktopHostPortForward } from "@bb/desktop-contract";
import { Button } from "@bb/shared-ui/button";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useHosts } from "@/hooks/queries/host-queries";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

export function describeForward(forward: BbDesktopHostPortForward): string {
  return forward.localPort === forward.port
    ? `${forward.port} -> localhost:${forward.localPort}`
    : `${forward.port} -> localhost:${forward.localPort} (local port ${forward.port} was busy)`;
}

export function PortForwardsSettings() {
  const hostPorts = getBbDesktopInfo()?.hostPorts ?? null;
  const [forwards, setForwards] = useState<BbDesktopHostPortForward[]>([]);
  const { data: hosts } = useHosts();
  useEffect(() => {
    if (hostPorts === null) return;
    const controller = new AbortController();
    void hostPorts.list().then((list) => {
      if (!controller.signal.aborted) setForwards(list);
    });
    const unsubscribe = hostPorts.onChange(setForwards);
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [hostPorts]);
  if (hostPorts === null || forwards.length === 0) return null;
  return (
    <SettingsSection
      title="Port forwards"
      description="Ports of your machines that this computer forwards to localhost. Any program on this computer can use them, and a browser sends its cookies for localhost:<port> to the remote service. They end when you quit the app."
    >
      <SettingsRowList>
        {forwards.map((forward) => (
          <SettingsRow
            key={`${forward.serverOrigin}|${forward.hostId}|${forward.port}`}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground">
                {hosts?.find((host) => host.id === forward.hostId)?.name ??
                  forward.hostId}
              </span>
              <span className="truncate text-xs tabular-nums text-subtle-foreground">
                {describeForward(forward)} · {forward.connections}{" "}
                {forward.connections === 1 ? "connection" : "connections"}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void hostPorts.stop({
                  hostId: forward.hostId,
                  port: forward.port,
                })
              }
            >
              Stop
            </Button>
          </SettingsRow>
        ))}
      </SettingsRowList>
    </SettingsSection>
  );
}
