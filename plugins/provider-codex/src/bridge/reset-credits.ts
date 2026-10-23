import type { ProviderUsage } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { fetchChatGpt } from "../ai/chatgpt-fetch.js";
import type { CodexAuthCredentials } from "../ai/codex-auth.js";

type ChatGptCredentials = Extract<CodexAuthCredentials, { type: "chatgpt" }>;
export type CodexResetCredits = NonNullable<
  Extract<ProviderUsage, { status: "ok" }>["resetCredits"]
>;
export type CodexConsumeResetOutcome =
  | { outcome: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed" }
  | { outcome: "failed"; message: string };

const CODEX_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_CONSUME_RESET_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
const RESET_FETCH_TIMEOUT_MS = 15_000;
const RESET_CONSUME_TIMEOUT_MS = 25_000;

const usageResetSummarySchema = z.object({
  rate_limit_reset_credits: z
    .object({
      available_count: z.number().int().nonnegative(),
      applicable_available_count: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
});
const resetCreditListSchema = z.object({
  credits: z.array(
    z.object({
      status: z.string(),
      expires_at: z.string().nullish(),
    }),
  ),
});
const consumeResponseSchema = z.object({
  code: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
});

export function codexRequestHeaders(credentials: ChatGptCredentials): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    originator: "bb",
    "User-Agent": "bb-provider-codex",
    Accept: "application/json",
  });
  if (credentials.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
  return headers;
}

function chatGptRequest(
  url: string,
  headers: Headers,
  init: Omit<RequestInit, "headers" | "signal">,
  timeoutMs: number,
): Promise<Response> {
  return fetchChatGpt({
    url,
    init: (cloudflareHeaders) => {
      const requestHeaders = new Headers(headers);
      for (const [key, value] of cloudflareHeaders) {
        requestHeaders.set(key, value);
      }
      return {
        ...init,
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      };
    },
  });
}

export function parseCodexResetSummary(
  raw: unknown,
): { available: number; usableNow: number } | null {
  const parsed = usageResetSummarySchema.safeParse(raw);
  const summary = parsed.success ? parsed.data.rate_limit_reset_credits : null;
  if (!summary) return null;
  return {
    available: summary.available_count,
    usableNow: Math.min(
      summary.available_count,
      summary.applicable_available_count ?? 0,
    ),
  };
}

export function earliestCodexResetExpiry(
  raw: unknown,
  nowMs: number,
): string | null {
  const parsed = resetCreditListSchema.safeParse(raw);
  if (!parsed.success) return null;
  const expiries = parsed.data.credits
    .filter((credit) => credit.status === "available" && credit.expires_at)
    .map((credit) => Date.parse(credit.expires_at!))
    .filter((time) => Number.isFinite(time) && time > nowMs)
    .sort((a, b) => a - b);
  return expiries.length === 0 ? null : new Date(expiries[0]!).toISOString();
}

export async function readCodexResetCredits(
  usageBody: unknown,
  credentials: ChatGptCredentials,
): Promise<CodexResetCredits | null> {
  const summary = parseCodexResetSummary(usageBody);
  if (summary === null) return null;
  if (summary.available === 0) return { ...summary, nextExpiresAt: null };
  try {
    const response = await chatGptRequest(
      CODEX_RESET_CREDITS_URL,
      codexRequestHeaders(credentials),
      { method: "GET" },
      RESET_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { ...summary, nextExpiresAt: null };
    }
    return {
      ...summary,
      nextExpiresAt: earliestCodexResetExpiry(
        await response.json(),
        Date.now(),
      ),
    };
  } catch {
    return { ...summary, nextExpiresAt: null };
  }
}

export async function consumeCodexResetCredit(
  credentials: ChatGptCredentials,
  requestId: string,
): Promise<CodexConsumeResetOutcome> {
  const headers = codexRequestHeaders(credentials);
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await chatGptRequest(
      CODEX_CONSUME_RESET_URL,
      headers,
      {
        method: "POST",
        body: JSON.stringify({ redeem_request_id: requestId }),
      },
      RESET_CONSUME_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      outcome: "failed",
      message: `Codex could not be reached to redeem the reset: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return {
      outcome: "failed",
      message: "Sign in to Codex again to redeem resets.",
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      outcome: "failed",
      message: `Codex reset request failed (HTTP ${response.status}).`,
    };
  }
  const parsed = consumeResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      outcome: "failed",
      message: "Codex returned an unexpected reset response.",
    };
  }
  return { outcome: parsed.data.code };
}
