import {
  hostToolchain,
  installSafeProcessDiagnostics,
  installSocketTypeOfServiceGuard,
  writeSafeProcessDiagnosticReport,
} from "@bb/process-utils";
import { join } from "node:path";
import { loadServerConfig } from "@bb/config/server";
import { internal_DO_NOT_USE_registerManagedProcess } from "@bb/config/managed-process-registration";

const serverConfig = loadServerConfig();
const diagnosticsLogsDir = join(serverConfig.BB_DATA_DIR, "logs");


function reportStartupFailure(error: unknown): void {
  try {
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: diagnosticsLogsDir,
      processName: "server",
      error,
    });
  } catch {}

  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const registration = process.argv.includes("--bb-managed-bootstrap")
    ? await internal_DO_NOT_USE_registerManagedProcess("server", process)
    : undefined;
  registration?.assertBootstrapActive();
  if (registration !== undefined) {
    const { internal_DO_NOT_USE_assertManagedRootAdmission } = await import("@bb/config/file-lock");
    registration.assertBootstrapActive();
    internal_DO_NOT_USE_assertManagedRootAdmission("server bootstrap diagnostics");
  }
  installSafeProcessDiagnostics({
    logsDir: diagnosticsLogsDir,
    processName: "server",
  });
  installSocketTypeOfServiceGuard();
  void hostToolchain.refresh();
  registration?.assertBootstrapActive();
  const serverModule = await import("./start-server.js");
  registration?.assertBootstrapActive();
  await serverModule.runServer(serverConfig, registration === undefined ? undefined : { managedRoot: registration });
}

void main().catch((error: unknown) => {
  if (process.argv.includes("--bb-managed-bootstrap")) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } else {
    reportStartupFailure(error);
  }
});
