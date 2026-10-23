import { afterEach, describe, expect, it, vi } from "vitest";
import { resetChatGptCloudflareCookiesForTests } from "../ai/chatgpt-fetch.js";
import {
  consumeCodexResetCredit,
  earliestCodexResetExpiry,
  parseCodexResetSummary,
} from "./reset-credits.js";

const credentials = {
  type: "chatgpt" as const,
  accessToken: "access-token",
  accountId: "account-123",
  accountEmail: null,
  expired: false,
  isFedrampAccount: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatGptCloudflareCookiesForTests();
});

describe("Codex reset credits", () => {
  it("never reports more usable resets than the account holds", () => {
    expect(
      parseCodexResetSummary({
        rate_limit_reset_credits: {
          available_count: 1,
          applicable_available_count: 3,
        },
      }),
    ).toEqual({ available: 1, usableNow: 1 });
    expect(parseCodexResetSummary({ rate_limit: null })).toBeNull();
  });

  it("ignores spent and past credits when picking the next expiry", () => {
    const now = Date.parse("2026-10-23T00:00:00Z");
    expect(
      earliestCodexResetExpiry(
        {
          credits: [
            { status: "redeemed", expires_at: "2026-10-24T00:00:00Z" },
            { status: "available", expires_at: "2026-10-01T00:00:00Z" },
            { status: "available", expires_at: "2026-11-06T00:00:00Z" },
            { status: "available", expires_at: null },
          ],
        },
        now,
      ),
    ).toBe("2026-11-06T00:00:00.000Z");
  });

  it.each([
    ["reset", "reset"],
    ["nothing_to_reset", "nothing_to_reset"],
    ["no_credit", "no_credit"],
    ["already_redeemed", "already_redeemed"],
  ] as const)("maps the %s code", async (code, outcome) => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code, windows_reset: 1 }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      consumeCodexResetCredit(credentials, "request-1"),
    ).resolves.toEqual({ outcome });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      redeem_request_id: "request-1",
    });
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
      "account-123",
    );
  });

  it("fails without spending when the login is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("", { status: 401 })),
    );

    await expect(
      consumeCodexResetCredit(credentials, "request-1"),
    ).resolves.toEqual({
      outcome: "failed",
      message: "Sign in to Codex again to redeem resets.",
    });
  });
});
