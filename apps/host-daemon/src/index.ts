import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostDaemonStartConfig } from "@bb/config/host-daemon";
import { loadHostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";
import {
  installSafeProcessDiagnostics,
  installSocketTypeOfServiceGuard,
  writeSafeProcessDiagnosticReport,
} from "@bb/process-utils";
import { hasMachineSuspensionMarker } from "./suspension-marker.js";
import { internal_DO_NOT_USE_registerManagedProcess, type ManagedProcessRegistration } from "@bb/config/managed-process-registration";

interface ReportStartupFailureArgs {
  diagnosticsLogsDir: string;
  error: unknown;
}

type MainFailureHandler = (error: unknown) => void;

const entrypointDir = dirname(fileURLToPath(import.meta.url));

function resolveEntrypointBridgeBundleDir(): string | undefined {
  return existsSync(join(entrypointDir, "bb-provider-bridge-worker.mjs"))
    ? entrypointDir
    : undefined;
}

function resolveDiagnosticsLogsDir(): string {
  const hostDaemonStartConfig = loadHostDaemonStartConfig({});

  return join(hostDaemonStartConfig.dataDir, "logs");
}

function reportStartupFailure(args: ReportStartupFailureArgs): void {
  try {
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: args.diagnosticsLogsDir,
      processName: "host-daemon",
      error: args.error,
    });
  } catch {}

  const message =
    args.error instanceof Error
      ? (args.error.stack ?? args.error.message)
      : String(args.error);
  process.stderr.write(`${message}\n`, () => process.exit(1));
}

async function runHostDaemonEntrypoint(registration: ManagedProcessRegistration | undefined): Promise<void> {
  registration?.assertBootstrapActive();
  const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig();
  const hostDaemonStartConfig = loadHostDaemonStartConfig({});
  if (await hasMachineSuspensionMarker(hostDaemonStartConfig.dataDir)) {
    return;
  }
  registration?.assertBootstrapActive();
  const hostDaemonModule = await import("./start-host-daemon.js");
  registration?.assertBootstrapActive();
  const daemon = await hostDaemonModule.startHostDaemon({
    managedRoot: registration,
    bbExecutableDirectory: hostDaemonEntrypointConfig.BB_CLI_DIR,
    bridgeBundleDir:
      hostDaemonEntrypointConfig.BB_BRIDGE_DIR ??
      resolveEntrypointBridgeBundleDir(),
    serverHeaders: hostDaemonEntrypointConfig.BB_SERVER_HEADERS,
    autoUpdate: hostDaemonEntrypointConfig.BB_HOST_DAEMON_AUTO_UPDATE,
    supervised: hostDaemonEntrypointConfig.BB_HOST_DAEMON_SUPERVISED,
    enrollKey: hostDaemonEntrypointConfig.BB_HOST_ENROLL_KEY,
    hostId: hostDaemonEntrypointConfig.BB_HOST_ID,
  });
  await daemon.waitUntilStopped();
}

const entrypointPath = process.argv[1];
const isMainModule =
  typeof entrypointPath === "string" &&
  fileURLToPath(import.meta.url) === entrypointPath;

async function runMain(): Promise<void> {
  const registration = process.argv.includes("--bb-managed-bootstrap")
    ? await internal_DO_NOT_USE_registerManagedProcess("host-daemon", process)
    : undefined;
  registration?.assertBootstrapActive();
  if (registration !== undefined) {
    const { internal_DO_NOT_USE_assertManagedRootAdmission } = await import("@bb/config/file-lock");
    registration.assertBootstrapActive();
    internal_DO_NOT_USE_assertManagedRootAdmission("host daemon bootstrap diagnostics");
  }
  const diagnosticsLogsDir = resolveDiagnosticsLogsDir();
  installSafeProcessDiagnostics({
    logsDir: diagnosticsLogsDir,
    processName: "host-daemon",
  });
  installSocketTypeOfServiceGuard();
  const handleMainFailure: MainFailureHandler = (error) => {
    if (registration !== undefined) throw error;
    reportStartupFailure({ diagnosticsLogsDir, error });
  };
  registration?.assertBootstrapActive();
  await runHostDaemonEntrypoint(registration).catch(handleMainFailure);
}

if (isMainModule) {
  void runMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
