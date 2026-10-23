import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { consumeClaudeResetCredit } from "./bridge/provider-maintenance.js";
import { resolveClaudeNativeRoots } from "./native-roots.js";
import { claudeUsageResetHostContract } from "./usage-reset-host-contract.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const claudeHostContract = defineRpcContract({
  ...experimental_nativeRootsHostContract,
  ...claudeUsageResetHostContract,
});

export default experimental_defineHostEntry({
  contract: claudeHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
    "claude.usage.consumeReset": async ({ requestId }) => {
      const result = await consumeClaudeResetCredit(requestId);
      return {
        outcome: result.outcome,
        message: result.outcome === "failed" ? result.message : null,
      };
    },
  },
});
