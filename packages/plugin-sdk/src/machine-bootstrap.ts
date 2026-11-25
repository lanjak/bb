import type { PluginMachineProviderProgress } from "./machine-provider.js";

export interface MachineExecutorRequest {
  command: string[];
  timeoutMs: number;
  signal: AbortSignal;
  stdin: string;
  onOutput: (chunk: string) => void;
}

export interface MachineExecutor {
  exec(request: MachineExecutorRequest): Promise<{ exitCode: number }>;
}

export interface MachineBootstrapRequest {
  key: string;
  executor: MachineExecutor;
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
}

export interface MachineUninstallRequest {
  hostId: string;
  executor: MachineExecutor;
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
}

export interface MachineBootstrapApi {
  bootstrap(request: MachineBootstrapRequest): Promise<{ hostId: string }>;
  /**
   * Run bb's installer through the executor to stop and remove the machine
   * service and data directory of a machine your provider created. Succeeds
   * when no installation is found there.
   */
  uninstall(request: MachineUninstallRequest): Promise<void>;
}
