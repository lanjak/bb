import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import type { UsageConsumeResetOutput } from "./usage-source-contract.js";
import type {
  UsageMachine,
  UsageProvider,
  UsageSnapshot,
} from "./usage-schema.js";

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const RESET_MESSAGES: Record<UsageConsumeResetOutput["outcome"], string> = {
  reset: "Reset used. The account's limits were reset.",
  nothing_to_reset: "Nothing to reset right now. The reset was kept.",
  no_credit: "No reset was available to use.",
  already_redeemed: "That reset was already used.",
  failed: "The reset could not be used.",
};

export interface UsageCliOperations {
  readAll(force: boolean): Promise<UsageSnapshot>;
  useReset(id: string): Promise<UsageConsumeResetOutput>;
}

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function attempt(
  work: () => Promise<PluginCliResult>,
): Promise<PluginCliResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(
      error instanceof Error ? error.message : String(error),
      { code: "usage_command_failed" },
    );
  }
}

function usageColumn(provider: UsageProvider): string {
  const usage = provider.usage;
  switch (usage?.status) {
    case undefined:
      return "not reported";
    case "ok":
      return usage.windows.length === 0
        ? "no limits"
        : usage.windows
            .map(
              (window) => `${window.label} ${Math.round(window.usedPercent)}%`,
            )
            .join(", ");
    case "not_installed":
      return "not installed";
    case "unauthenticated":
      return "signed out";
    case "expired":
      return "session expired";
    case "error":
      return usage.message;
  }
}

function resetsColumn(provider: UsageProvider): string {
  const credits =
    provider.usage?.status === "ok" ? provider.usage.resetCredits : null;
  if (credits === null) return "-";
  const parts = [`${credits.available}`, `${credits.usableNow} usable now`];
  if (credits.nextExpiresAt !== null)
    parts.push(`next expires ${credits.nextExpiresAt.slice(0, 10)}`);
  return `${parts[0]} (${parts.slice(1).join(", ")})`;
}

function rows(machines: readonly UsageMachine[]) {
  return machines.flatMap((machine) =>
    machine.providers
      .filter((provider) => provider.usage?.status !== "not_installed")
      .map((provider) => ({ machine, provider })),
  );
}

function formatTable(machines: readonly UsageMachine[]): string {
  const entries = rows(machines);
  if (entries.length === 0) return "No provider usage reported.\n";
  const table = [
    ["ID", "Machine", "Provider", "Account", "Usage", "Resets"],
    ...entries.map(({ machine, provider }) => [
      provider.id,
      machine.displayName,
      provider.displayName,
      provider.accountLabel ??
        (provider.usage?.status === "ok"
          ? provider.usage.accountEmail
          : null) ??
        "-",
      usageColumn(provider),
      resetsColumn(provider),
    ]),
  ];
  const widths = table[0]!.map((_, column) =>
    Math.max(...table.map((row) => row[column]!.length)),
  );
  return `${table
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
}

export function registerUsageCli(
  bb: Pick<BbPluginApi, "cli">,
  operations: UsageCliOperations,
): void {
  bb.cli.register(
    defineCli({
      name: "usage",
      summary: "Show provider usage limits and spend usage-limit resets",
      description:
        "Lists every machine's and shared source's accounts as the Provider usage card shows them. A reset spends one of an account's usage-limit resets and cannot be undone.",
      commands: {
        list: cliCommand({
          summary: "List accounts with their usage windows and resets",
          options: {
            refresh: {
              type: "boolean",
              description:
                "Measure every account now instead of using recent results",
            },
            json: JSON_OPTION,
          },
          run: (input) =>
            attempt(async () => {
              const snapshot = await operations.readAll(
                input.options.refresh === true,
              );
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? json(snapshot)
                  : formatTable(snapshot.machines),
              };
            }),
        }),
        reset: cliCommand({
          summary: "Spend one usage-limit reset for an account",
          description:
            "The provider decides whether a limit is eligible; when nothing needs resetting the reset is kept.",
          positionals: [
            {
              name: "id",
              description: "Account ID from `bb usage list`",
              required: true,
            },
          ],
          options: {
            yes: {
              type: "boolean",
              description:
                "Required. Confirms spending a reset, which cannot be undone",
            },
            json: JSON_OPTION,
          },
          run: (input) =>
            attempt(async () => {
              if (!input.options.yes)
                throw new PluginCliError(
                  "Spending a reset cannot be undone. Rerun with --yes to confirm.",
                  { code: "missing_required" },
                );
              const result = await operations.useReset(input.positionals.id);
              return {
                exitCode: result.outcome === "failed" ? 1 : 0,
                stdout: input.options.json
                  ? json(result)
                  : `${result.message ?? RESET_MESSAGES[result.outcome]}\n`,
              };
            }),
        }),
      },
    }),
  );
}
