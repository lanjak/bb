import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { INSTALL_MACHINE_SCRIPT_PATH } from "../../install-machine-asset.js";
import type { EnrollmentBootstrap } from "./enrollments.js";

export const INSTALLER_TIMEOUT_MS = 600_000;

const enrollmentInstallerScript = `
set -eu
umask 077
BB_ENROLLMENT=$(cat)
export BB_ENROLLMENT
installer_url=$1
installer_file=$(mktemp)
trap 'rm -f "$installer_file"' EXIT HUP INT TERM
node -e 'for (const [name,value] of Object.entries(JSON.parse(process.env.BB_ENROLLMENT).headers ?? {})) console.log("header = " + JSON.stringify(name + ": " + value))' | curl --config - --fail --silent --show-error --location --connect-timeout 10 --max-time 60 "$installer_url" > "$installer_file"
sh "$installer_file" --bootstrap-env BB_ENROLLMENT
`;

const redemptionInstallerScript = `
set -eu
umask 077
credential=$(cat)
installer_url=$1
installer_file=$(mktemp)
trap 'rm -f "$installer_file"' EXIT HUP INT TERM
status=0
printf 'header = "X-BB-Enrollment: %s"\\n' "$credential" | curl --config - --fail-with-body --silent --show-error --location --connect-timeout 10 --max-time 120 "$installer_url" > "$installer_file" || status=$?
sh "$installer_file" || exit
exit "$status"
`;

const installerSource = readFile(INSTALL_MACHINE_SCRIPT_PATH, "utf8");

export interface InstallerExecution {
  command: string[];
  stdin: string;
  secrets: string[];
}

export function enrollmentInstallerExecution(
  bootstrap: EnrollmentBootstrap,
): InstallerExecution {
  return {
    command: [
      "sh",
      "-c",
      enrollmentInstallerScript,
      "bb-machine-install",
      new URL("/install.sh", bootstrap.serverUrl).href,
    ],
    stdin: JSON.stringify(bootstrap),
    secrets: [bootstrap.credential, ...Object.values(bootstrap.headers ?? {})],
  };
}

export function redemptionInstallerExecution(args: {
  serverUrl: string;
  credential: string;
}): InstallerExecution {
  return {
    command: [
      "sh",
      "-c",
      redemptionInstallerScript,
      "bb-machine-install",
      new URL("/install.sh", args.serverUrl).href,
    ],
    stdin: args.credential,
    secrets: [args.credential],
  };
}

export async function installerLifecycleExecution(
  action: "start" | "uninstall",
  hostId: string,
): Promise<InstallerExecution> {
  return {
    command: ["sh", "-s", "--", `--${action}`, "--host-id", hostId],
    stdin: await installerSource,
    secrets: [],
  };
}

function redact(line: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (text, secret) =>
      secret.length < 8 ? text : text.replaceAll(secret, "[redacted]"),
    line,
  );
}

function printable(line: string): string {
  return stripVTControlCharacters(line).replace(/(?!\t)\p{Cc}/gu, "");
}

function createOutputReporter(
  report: PluginMachineProviderProgress,
  secrets: readonly string[],
) {
  let pending = "";
  const tail: string[] = [];
  const emit = (raw: string, terminated: boolean): void => {
    const line = redact(printable(raw), secrets);
    report.log(line + (terminated ? "\n" : ""));
    tail.push(line);
    if (tail.length > 20) tail.shift();
  };
  return {
    onOutput(chunk: string): void {
      pending += chunk;
      for (;;) {
        const match = /\r\n|\r|\n/u.exec(pending);
        if (match === null) return;
        emit(pending.slice(0, match.index), true);
        pending = pending.slice(match.index + match[0].length);
      }
    },
    finish(): void {
      if (pending.length === 0) return;
      emit(pending, false);
      pending = "";
    },
    failureMessage(failure: string): string {
      return tail.length === 0 ? failure : `${failure}:\n${tail.join("\n")}`;
    },
  };
}

async function untilAborted<T>(
  signal: AbortSignal,
  work: Promise<T>,
): Promise<T> {
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function runInstallerExecution(args: {
  executor: MachineExecutor;
  execution: InstallerExecution;
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
  timeoutMs: number;
  failure: string;
}): Promise<void> {
  const output = createOutputReporter(args.report, args.execution.secrets);
  let result;
  try {
    result = await untilAborted(
      args.signal,
      args.executor.exec({
        command: args.execution.command,
        stdin: args.execution.stdin,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
        onOutput: output.onOutput,
      }),
    );
  } catch {
    args.signal.throwIfAborted();
    output.finish();
    throw new Error(output.failureMessage(args.failure));
  }
  output.finish();
  if (result.exitCode !== 0)
    throw new Error(output.failureMessage(args.failure));
}
