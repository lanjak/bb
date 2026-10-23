import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  usageConsumeResetInputSchema,
  usageConsumeResetOutputSchema,
} from "./usage-contract.js";

export const claudeUsageResetHostContract = defineRpcContract({
  "claude.usage.consumeReset": {
    input: usageConsumeResetInputSchema.pick({ requestId: true }).strict(),
    output: usageConsumeResetOutputSchema,
  },
});
