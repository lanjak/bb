import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const usagePlanSchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().int().positive().nullable(),
});
const accountFields = {
  plan: usagePlanSchema.nullable().default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};
export const usageWindowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "custom",
]);
const usageWindowSchema = z.object({
  kind: usageWindowKindSchema.default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z
    .number()
    .nonnegative()
    .describe("Percentage consumed; may exceed 100 for overage."),
  resetsAt: z
    .string()
    .nullable()
    .describe("ISO timestamp, or null when no reset is known."),
  model: z
    .string()
    .nullable()
    .describe("Applicable model family, or null for all models."),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});
export const usageResetCreditsSchema = z.object({
  available: z
    .number()
    .int()
    .nonnegative()
    .describe("Unspent usage-limit resets the account holds."),
  usableNow: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Resets that would apply to a current window now; 0 when no window is eligible.",
    ),
  nextExpiresAt: z
    .string()
    .nullable()
    .describe(
      "ISO expiry of the earliest unspent reset, or null when unknown or none expire.",
    ),
});
const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...accountFields,
    windows: z.array(usageWindowSchema),
    resetCredits: usageResetCreditsSchema
      .nullable()
      .default(null)
      .describe(
        "Null when the provider reports no reset program for the account.",
      ),
  }),
  z.object({ status: z.literal("not_installed"), ...accountFields }),
  z.object({ status: z.literal("unauthenticated"), ...accountFields }),
  z.object({ status: z.literal("expired"), ...accountFields }),
  z.object({
    status: z.literal("error"),
    ...accountFields,
    message: z.string(),
  }),
]);
export const usageAccountKeySchema = z
  .string()
  .min(1)
  .nullable()
  .default(null)
  .describe(
    "Provider-issued quota account identity, namespaced by issuer and account/organization scope. Never use email, a display label, a source-local ID, or credentials. Null means unknown; unknown accounts must not be merged.",
  );
export const usageResourceSchema = z.object({
  accountKey: usageAccountKeySchema,
  id: z
    .string()
    .min(1)
    .describe("Stable resource ID within this source plugin."),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});
export const usageResourceListSchema = z.object({
  label: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Declares a shared group even when empty. Host-only sources omit it; machine groups use host names.",
    ),
  resources: z.array(usageResourceSchema),
});
export const usageMeasurementSchema = z.object({
  accountKey: usageAccountKeySchema,
  observedAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "Last successful measurement time in epoch milliseconds; null if never observed.",
    ),
  usage: usageSchema,
});
export const usageListInputSchema = z.object({});
export const usageFetchInputSchema = z.object({
  resourceId: z.string().min(1),
  refresh: z
    .boolean()
    .describe(
      "False permits a cached measurement but still returns actual usage. True requests a fresh collection attempt for this resource only.",
    ),
});
export const usageConsumeResetInputSchema = z.object({
  resourceId: z.string().min(1),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u)
    .describe(
      "Idempotency key for one reset attempt. Reuse it only to retry that attempt.",
    ),
});
export const usageConsumeResetOutcomeSchema = z.enum([
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
  "failed",
]);
export const usageConsumeResetOutputSchema = z.object({
  outcome: usageConsumeResetOutcomeSchema,
  message: z
    .string()
    .min(1)
    .nullable()
    .describe("Provider explanation when outcome is failed; otherwise null."),
});
export type UsageMeasurement = z.infer<typeof usageMeasurementSchema>;
export type UsageResetCredits = z.infer<typeof usageResetCreditsSchema>;
export type UsageConsumeResetOutput = z.infer<
  typeof usageConsumeResetOutputSchema
>;
export type UsageResource = z.infer<typeof usageResourceSchema> &
  UsageMeasurement;
export const usageListMethod = "provider-usage.v1.listResources";
export const usageFetchMethod = "provider-usage.v1.getResource";
export const usageConsumeResetMethod = "provider-usage.v1.consumeReset";
export const usageSourceRpcContract = defineRpcContract({
  [usageListMethod]: {
    input: usageListInputSchema,
    output: usageResourceListSchema,
    experimental_description:
      "Cheap complete inventory of resources owned by this source. Reads local metadata only; never refreshes quota or contacts providers. IDs are stable and source-local. Resource order is display order. Shared label preserves empty groups. Resources may disappear between list and fetch.",
  },
  [usageFetchMethod]: {
    input: usageFetchInputSchema,
    output: usageMeasurementSchema,
    experimental_description:
      "Returns actual usage for exactly one listed resource, even when refresh is false. False permits cached observations; true requests a fresh attempt. Never collects other resources as a side effect. A removed resource fails the RPC; consumers relist. Per-account authentication and collection failures are usage states. observedAt is the last successful measurement time.",
  },
});
export const usageResetRpcContract = defineRpcContract({
  [usageConsumeResetMethod]: {
    input: usageConsumeResetInputSchema,
    output: usageConsumeResetOutputSchema,
    experimental_description:
      "Optional. Spends one usage-limit reset for exactly one listed resource whose usage reports resetCredits. Irreversible when outcome is reset; nothing_to_reset and no_credit keep the credit. The same requestId never spends twice. Sources without resets do not register it.",
  },
});
