import type { ProviderUsage } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export type ClaudeResetCredits = NonNullable<
  Extract<ProviderUsage, { status: "ok" }>["resetCredits"]
>;
export type ClaudeConsumeResetOutcome =
  | { outcome: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed" }
  | { outcome: "failed"; message: string };

export const CLAUDE_RESET_PROGRAM = "cedar_ember";
export const CLAUDE_RESET_QUERY = { cedar_ember: "1", skip_spend: "1" };

const grantSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/u),
  resets_left: z.number().int().nonnegative(),
  ends_at: z.string().nullish(),
  paused: z.boolean().nullish(),
  usable_now: z.boolean().nullish(),
});
const programSchema = z.object({
  eligible: z.boolean(),
  grants: z.array(z.unknown()).nullish(),
  next_grant_id: z.string().nullish(),
});
const usageProgramSchema = z.object({ cedar_ember: z.unknown().nullish() });
const claimResponseSchema = z.object({
  result: z.enum([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
});

function liveGrants(raw: unknown, nowMs: number) {
  const usage = usageProgramSchema.safeParse(raw);
  const program = programSchema.safeParse(
    usage.success ? usage.data.cedar_ember : null,
  );
  if (!program.success || !program.data.eligible) return null;
  const grants = (program.data.grants ?? [])
    .flatMap((value) => {
      const grant = grantSchema.safeParse(value);
      return grant.success ? [grant.data] : [];
    })
    .filter((grant) => {
      if (grant.paused || grant.resets_left === 0) return false;
      if (grant.ends_at == null) return true;
      const endsAt = Date.parse(grant.ends_at);
      return Number.isFinite(endsAt) && endsAt > nowMs;
    });
  return { grants, nextGrantId: program.data.next_grant_id ?? null };
}

export function parseClaudeResetCredits(
  raw: unknown,
  nowMs: number,
): ClaudeResetCredits | null {
  const live = liveGrants(raw, nowMs);
  if (live === null) return null;
  const expiries = live.grants
    .map((grant) => (grant.ends_at ? Date.parse(grant.ends_at) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    available: live.grants.reduce((sum, grant) => sum + grant.resets_left, 0),
    usableNow: live.grants
      .filter((grant) => grant.usable_now)
      .reduce((sum, grant) => sum + grant.resets_left, 0),
    nextExpiresAt:
      expiries.length === 0 ? null : new Date(expiries[0]!).toISOString(),
  };
}

export function nextClaudeGrantId(raw: unknown, nowMs: number): string | null {
  const live = liveGrants(raw, nowMs);
  if (live === null) return null;
  const usable = live.grants.filter((grant) => grant.usable_now);
  return (
    usable.find((grant) => grant.id === live.nextGrantId)?.id ??
    usable[0]?.id ??
    null
  );
}

export function claudeClaimOutcome(raw: unknown): ClaudeConsumeResetOutcome {
  const parsed = claimResponseSchema.safeParse(raw);
  if (!parsed.success)
    return {
      outcome: "failed",
      message: "Claude returned an unexpected reset response.",
    };
  switch (parsed.data.result) {
    case "reset":
      return { outcome: "reset" };
    case "already_used":
      return { outcome: "already_redeemed" };
    case "not_limited":
      return { outcome: "nothing_to_reset" };
    case "ineligible":
      return { outcome: "no_credit" };
    case "cooldown":
      return {
        outcome: "failed",
        message: "Claude resets are cooling down. Try again later.",
      };
    case "unavailable":
      return {
        outcome: "failed",
        message:
          "Claude could not confirm the reset. If you are still limited in a moment, try again.",
      };
  }
}
