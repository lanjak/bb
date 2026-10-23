import { describe, expect, it } from "vitest";
import {
  claudeClaimOutcome,
  nextClaudeGrantId,
  parseClaudeResetCredits,
} from "./reset-credits.js";

const now = Date.parse("2026-10-23T00:00:00Z");

function usage(cedarEmber: unknown) {
  return { five_hour: null, cedar_ember: cedarEmber };
}

describe("Claude reset credits", () => {
  it("reports nothing when the account is not in the reset program", () => {
    expect(parseClaudeResetCredits(usage(null), now)).toBeNull();
    expect(
      parseClaudeResetCredits(
        usage({ eligible: false, ineligible_reason: "surface" }),
        now,
      ),
    ).toBeNull();
  });

  it("counts live grants and skips paused, empty, and expired ones", () => {
    const body = usage({
      eligible: true,
      next_grant_id: "grant_b",
      grants: [
        {
          id: "grant_a",
          resets_left: 1,
          ends_at: "2026-10-01T00:00:00Z",
          usable_now: true,
        },
        {
          id: "grant_b",
          resets_left: 2,
          ends_at: "2026-11-30T00:00:00Z",
          usable_now: true,
        },
        {
          id: "grant_c",
          resets_left: 1,
          ends_at: "2026-11-02T00:00:00Z",
          usable_now: false,
        },
        { id: "grant_d", resets_left: 3, paused: true, usable_now: true },
        { id: "grant_e", resets_left: 0, usable_now: true },
        { id: "Not A Valid Id!", resets_left: 9, usable_now: true },
      ],
    });

    expect(parseClaudeResetCredits(body, now)).toEqual({
      available: 3,
      usableNow: 2,
      nextExpiresAt: "2026-11-02T00:00:00.000Z",
    });
    expect(nextClaudeGrantId(body, now)).toBe("grant_b");
  });

  it("falls back to another usable grant when the suggested one is gone", () => {
    expect(
      nextClaudeGrantId(
        usage({
          eligible: true,
          next_grant_id: "grant_gone",
          grants: [{ id: "grant_x", resets_left: 1, usable_now: true }],
        }),
        now,
      ),
    ).toBe("grant_x");
    expect(
      nextClaudeGrantId(
        usage({
          eligible: true,
          grants: [{ id: "grant_x", resets_left: 1, usable_now: false }],
        }),
        now,
      ),
    ).toBeNull();
  });

  it.each([
    ["reset", { outcome: "reset" }],
    ["already_used", { outcome: "already_redeemed" }],
    ["not_limited", { outcome: "nothing_to_reset" }],
    ["ineligible", { outcome: "no_credit" }],
  ] as const)("maps the %s claim result", (result, expected) => {
    expect(claudeClaimOutcome({ result })).toEqual(expected);
  });

  it("treats cooldowns and unconfirmed claims as failures to retry", () => {
    expect(claudeClaimOutcome({ result: "cooldown" })).toMatchObject({
      outcome: "failed",
    });
    expect(claudeClaimOutcome({ result: "unavailable" })).toMatchObject({
      outcome: "failed",
    });
    expect(claudeClaimOutcome({ result: "surprise" })).toMatchObject({
      outcome: "failed",
    });
  });
});
