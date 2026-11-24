import { PluginCliError, type PluginCliContext } from "@get-bb/plugin-sdk";

export const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

export const PROJECT_OPTION = {
  type: "string",
  placeholder: "id",
  description:
    "Required. Project that owns the automation; `bb project list --include-personal --json` lists ids",
} as const;

export function cliError(message: string, code: string): PluginCliError {
  return new PluginCliError(message, { code });
}

export function jsonOutput(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function requireProjectId(
  value: string | undefined,
  ctx: Pick<PluginCliContext, "projectId">,
): string {
  if (value !== undefined && value !== "") return value;
  const known = ctx.projectId;
  throw new PluginCliError("missing required option --project", {
    code: "missing_required",
    hint:
      known === undefined
        ? "Pass --project <id>; `bb project list --include-personal --json` lists project ids."
        : `This thread's project is ${known}; re-run with --project ${known}`,
  });
}

export function requireOptionValue(name: string, value: string): string {
  if (value === "") {
    throw cliError(
      `Missing required option --${name} <value>.`,
      "missing_required",
    );
  }
  return value;
}

export function formatTimestamp(value: number | null): string {
  return value === null ? "-" : new Date(value).toLocaleString();
}

export function table(head: string[], rows: string[][]): string {
  const widths = head.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return ["", format(head), ...rows.map(format), ""].join("\n") + "\n";
}
