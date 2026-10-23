import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  usageConsumeResetInputSchema,
  usageConsumeResetOutputSchema,
} from "./usage-contract.js";

export const codexUsageResetHostContract = defineRpcContract({
  "codex.usage.consumeReset": {
    input: usageConsumeResetInputSchema.pick({ requestId: true }).strict(),
    output: usageConsumeResetOutputSchema,
  },
});
