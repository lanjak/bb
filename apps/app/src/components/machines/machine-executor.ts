import type { Host } from "@bb/domain";
import type { SystemMachineProvider } from "@bb/server-contract";
import { hostCanRetryUpdate } from "@/lib/host-update-status";

export function machineExecutorPhrase(
  provider: SystemMachineProvider | null,
): string | null {
  return provider?.supportsExecutor ? `over ${provider.displayName}` : null;
}

export function machineExecutorUpdateLabel(
  host: Host,
  provider: SystemMachineProvider | null,
): string | null {
  const phrase = machineExecutorPhrase(provider);
  return phrase !== null && hostCanRetryUpdate(host)
    ? `Update ${phrase}`
    : null;
}
