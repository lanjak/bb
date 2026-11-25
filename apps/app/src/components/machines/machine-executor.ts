import type { SystemMachineProvider } from "@bb/server-contract";

export function machineExecutorPhrase(
  provider: SystemMachineProvider | null,
): string | null {
  return provider?.supportsExecutor ? `over ${provider.displayName}` : null;
}
