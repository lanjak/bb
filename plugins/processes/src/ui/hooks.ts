import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { processesContract } from "../../contract.js";

export function useMachines() {
  return experimental_useRpcQuery({
    contract: processesContract,
    method: "resources.machines",
    input: {},
  });
}

export function useMachineUsage(hostId: string) {
  return experimental_useRpcQuery({
    contract: processesContract,
    method: "resources.machine",
    input: { hostId },
  });
}

export function useThreadUsage(threadId: string) {
  return experimental_useRpcQuery({
    contract: processesContract,
    method: "resources.thread",
    input: { threadId },
  });
}
