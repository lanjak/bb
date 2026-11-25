import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  getHost,
  getLatestSessionForHost,
  getNonDestroyedHost,
  updateHost,
} from "@bb/db";
import {
  MACHINE_RECONNECT_FAILURE_PREFIX,
  type HostReconnectResponse,
} from "@bb/server-contract";
import { sliceUtf16Head, sliceUtf16Tail } from "@bb/text-utils";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { errorMessage } from "../lib/error-log-fields.js";
import { perDbRegistry } from "../lib/per-db-registry.js";
import {
  getMachineProvider,
  invokeMachineProvider,
  type PluginMachineProviderRecord,
} from "../plugins/plugin-machine-provider-registry.js";
import { decideWithinBox } from "../threads/dispatch-hooks.js";
import {
  findUnusedEnrollmentCredential,
  type EnrollmentBootstrap,
} from "./enrollments.js";
import {
  INSTALLER_TIMEOUT_MS,
  redemptionInstallerExecution,
  runInstallerExecution,
} from "./installer-runner.js";
import {
  manualEnrollmentCommand,
  manualEnrollmentPowerShellCommand,
} from "./manual-enrollment-command.js";
import { serverAccess } from "./server-access.js";

type Dependencies = Pick<
  AppDeps,
  "config" | "db" | "hub" | "logger" | "machineAuth"
>;

type HostRow = NonNullable<ReturnType<typeof getHost>>;

const SERVER_ACCESS_TIMEOUT_MS = 60_000;
const EXECUTOR_TIMEOUT_MS = 30_000;
const REACHABILITY_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 120_000;
const CONNECTION_POLL_MS = 250;
const RECONNECT_OPERATION_MARKER = ":reconnect:";

interface ReconnectOperation {
  controller: AbortController;
  unavailableReason: Promise<string | null>;
  done: Promise<void>;
}

const reconnectOperations = new WeakMap<
  object,
  Map<string, ReconnectOperation>
>();

export function isMachineReconnectOperationId(
  operationId: string | null,
): boolean {
  return operationId?.includes(RECONNECT_OPERATION_MARKER) === true;
}

export async function reconnectMachine(
  deps: Dependencies,
  args: { hostId: string; printCommand: boolean },
): Promise<HostReconnectResponse> {
  const host = requireReconnectableHost(deps, args.hostId);
  let unavailableReason: string | null = null;
  if (args.printCommand) {
    await abortMachineReconnect(deps, host.id);
  } else {
    const operation =
      perDbRegistry(reconnectOperations, deps.db).get(host.id) ??
      startExecutorReconnect(deps, host);
    if (operation !== null) {
      unavailableReason = await operation.unavailableReason;
      if (unavailableReason === null) {
        return {
          mode: "operation",
          hostId: host.id,
          progress: "in-progress",
        };
      }
    }
  }
  return {
    mode: "command",
    ...(await prepareReconnectCommand(deps, host.id)),
    unavailableReason,
  };
}

export async function abortMachineReconnect(
  deps: Pick<Dependencies, "db">,
  hostId: string,
): Promise<void> {
  const operation = perDbRegistry(reconnectOperations, deps.db).get(hostId);
  if (operation === undefined) return;
  operation.controller.abort();
  await operation.done;
}

export function recoverInterruptedMachineReconnect(
  deps: Pick<Dependencies, "db" | "hub">,
  hostId: string,
): void {
  const host = getHost(deps.db, hostId);
  if (
    host === null ||
    host.destroyedAt !== null ||
    host.phase !== "active" ||
    !isMachineReconnectOperationId(host.machineOperationId) ||
    perDbRegistry(reconnectOperations, deps.db).has(hostId)
  )
    return;
  updateHost(deps.db, deps.hub, hostId, {
    machineOperationId: null,
    statusMessage: `${MACHINE_RECONNECT_FAILURE_PREFIX} The server restarted during the reconnect. Reconnect again.`,
  });
  deps.hub.notifyHost(hostId, ["host-disconnected"]);
}

function requireReconnectableHost(deps: Dependencies, hostId: string) {
  const host = getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  if (resolvePrimaryHostId(deps) === hostId || host.phase !== "active")
    throw new ApiError(
      409,
      "machine_reconnect_unavailable",
      "Only active machines other than the server's own can be reconnected",
    );
  if (deps.hub.hasDaemonForHost(hostId))
    throw new ApiError(
      409,
      "machine_reconnect_not_needed",
      "Machine is connected and doesn't need reconnecting",
    );
  return host;
}

function startExecutorReconnect(
  deps: Dependencies,
  host: HostRow,
): ReconnectOperation | null {
  const record =
    host.machineProviderId === null
      ? undefined
      : getMachineProvider(host.machineProviderId);
  if (record === undefined || record.provider.executor === null) return null;
  if (host.resource === null) return null;
  const operations = perDbRegistry(reconnectOperations, deps.db);
  const controller = new AbortController();
  let ready: (unavailableReason: string | null) => void = () => {};
  const unavailableReason = new Promise<string | null>((resolve) => {
    ready = resolve;
  });
  const operation: ReconnectOperation = {
    controller,
    unavailableReason,
    done: Promise.resolve(),
  };
  operations.set(host.id, operation);
  operation.done = runExecutorReconnect(deps, {
    record,
    hostId: host.id,
    resource: host.resource,
    signal: controller.signal,
    ready,
  })
    .catch((error: unknown) => {
      ready(errorMessage(error));
      deps.logger.warn(
        { hostId: host.id, error: errorMessage(error) },
        "Machine reconnect failed",
      );
    })
    .finally(() => {
      if (operations.get(host.id) === operation) operations.delete(host.id);
    });
  return operation;
}

async function createMachineExecutor(args: {
  record: PluginMachineProviderRecord;
  hostId: string;
  resource: NonNullable<HostRow["resource"]>;
  signal: AbortSignal;
}): Promise<MachineExecutor> {
  const invocation = await invokeMachineProvider(
    args.record,
    "machine executor",
    () =>
      decideWithinBox(
        () =>
          Promise.resolve(
            args.record.provider.executor!({
              hostId: args.hostId,
              resource: args.resource,
              signal: args.signal,
            }),
          ),
        EXECUTOR_TIMEOUT_MS,
      ),
  );
  if (!invocation.ok) throw new Error(invocation.error);
  if (!invocation.value.ok) throw new Error(invocation.value.error);
  const executor = invocation.value.value;
  if (typeof executor?.exec !== "function")
    throw new Error("The machine provider returned an invalid executor");
  return {
    async exec(request) {
      const result = await invokeMachineProvider(
        args.record,
        "machine executor command",
        () => executor.exec(request),
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  };
}

async function runExecutorReconnect(
  deps: Dependencies,
  args: {
    record: PluginMachineProviderRecord;
    hostId: string;
    resource: NonNullable<HostRow["resource"]>;
    signal: AbortSignal;
    ready: (unavailableReason: string | null) => void;
  },
): Promise<void> {
  const { hostId, signal } = args;
  const executor = await createMachineExecutor(args);
  const current = getHost(deps.db, hostId);
  if (
    signal.aborted ||
    current === null ||
    current.destroyedAt !== null ||
    current.phase !== "active"
  )
    throw new Error("The machine changed before the reconnect started");
  const operationId = `${args.record.pluginId}${RECONNECT_OPERATION_MARKER}${randomUUID()}`;
  updateHost(deps.db, deps.hub, hostId, {
    machineOperationId: operationId,
    pendingLog: "",
    statusMessage: "Reconnecting machine...",
  });
  deps.hub.notifyHost(hostId, ["host-disconnected"]);
  args.ready(null);

  const owner = () => {
    const host = getHost(deps.db, hostId);
    return host !== null &&
      host.destroyedAt === null &&
      host.phase === "active" &&
      host.machineOperationId === operationId
      ? host
      : null;
  };
  const report = reconnectReporter(deps, hostId, owner);
  let issuedCredential = false;
  try {
    report.step("Checking the connection to the computer");
    await runInstallerExecution({
      executor,
      execution: { command: ["true"], stdin: "", secrets: [] },
      report,
      signal,
      timeoutMs: REACHABILITY_TIMEOUT_MS,
      failure: "Could not connect to the computer",
    });
    signal.throwIfAborted();
    report.step("Preparing the machine reconnection");
    const credential = await issueReconnectCredential(deps, hostId, signal);
    issuedCredential = true;
    signal.throwIfAborted();
    report.step("Running the machine installer");
    await runInstallerExecution({
      executor,
      execution: redemptionInstallerExecution(credential),
      report,
      signal,
      timeoutMs: INSTALLER_TIMEOUT_MS,
      failure: "The machine installer failed",
    });
    report.step("Waiting for machine connection");
    await waitForDaemon(deps, hostId, signal);
    if (owner() === null) return;
    updateHost(deps.db, deps.hub, hostId, {
      machineOperationId: null,
      statusMessage: null,
    });
    deps.hub.notifyHost(hostId, ["host-connected"]);
  } catch (error) {
    if (issuedCredential)
      await deps.machineAuth.revokeHostEnrollKeys({ hostId });
    if (owner() === null) return;
    const [summary] = errorMessage(error).split("\n");
    updateHost(deps.db, deps.hub, hostId, {
      machineOperationId: null,
      statusMessage: signal.aborted
        ? null
        : sliceUtf16Head(
            `${MACHINE_RECONNECT_FAILURE_PREFIX} ${summary!.replace(/:$/u, "")}`,
            500,
          ),
    });
    deps.hub.notifyHost(hostId, ["host-disconnected"]);
    deps.logger.warn(
      { hostId, error: summary },
      "Machine reconnect did not complete",
    );
  }
}

function reconnectReporter(
  deps: Dependencies,
  hostId: string,
  owner: () => HostRow | null,
): PluginMachineProviderProgress {
  const append = (text: string) => {
    const host = owner();
    if (host === null) return;
    updateHost(deps.db, deps.hub, hostId, {
      pendingLog: sliceUtf16Tail(
        host.pendingLog + (text.endsWith("\n") ? text : `${text}\n`),
        16_384,
      ),
    });
    deps.hub.notifyHost(hostId, ["host-disconnected"]);
  };
  return {
    step(text) {
      if (owner() === null) return;
      updateHost(deps.db, deps.hub, hostId, {
        statusMessage: sliceUtf16Head(text, 500),
      });
      append(text);
    },
    log: append,
  };
}

async function waitForDaemon(
  deps: Dependencies,
  hostId: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
  while (!deps.hub.hasDaemonForHost(hostId)) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for machine connection");
    await delay(CONNECTION_POLL_MS, undefined, { signal });
  }
}

function reconnectBootstrap(
  deps: Pick<Dependencies, "db">,
  args: {
    hostId: string;
    grant: { serverUrl: string; headers?: Record<string, string> };
    credential: string;
    expiresAt: number;
  },
): EnrollmentBootstrap {
  const session = getLatestSessionForHost(deps.db, { hostId: args.hostId });
  return {
    hostId: args.hostId,
    serverUrl: args.grant.serverUrl,
    ...(args.grant.headers === undefined
      ? {}
      : { headers: args.grant.headers }),
    credential: args.credential,
    expiresAt: args.expiresAt,
    reconnect: true,
    ...(session === null ? {} : { dataDir: session.dataDir }),
  };
}

async function issueReconnectCredential(
  deps: Dependencies,
  hostId: string,
  signal: AbortSignal,
) {
  const { serverUrl } = await serverAccess.resolve(deps, {
    key: hostId,
    hostId,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(SERVER_ACCESS_TIMEOUT_MS),
    ]),
  });
  const { key, expiresAt } = await deps.machineAuth.issueHostEnrollKey({
    hostId,
    enrollSource: "reconnect",
  });
  return { hostId, serverUrl, credential: key, expiresAt };
}

async function prepareReconnectCommand(deps: Dependencies, hostId: string) {
  const bootstrap = await issueReconnectCredential(
    deps,
    hostId,
    new AbortController().signal,
  ).catch((error: unknown) => {
    throw new ApiError(
      409,
      "machine_reconnect_unavailable",
      errorMessage(error),
    );
  });
  return {
    command: manualEnrollmentCommand(bootstrap),
    windowsCommand: manualEnrollmentPowerShellCommand(bootstrap),
    expiresAt: bootstrap.expiresAt,
    hostId,
  };
}

export async function reconnectBootstrapForCredential(
  deps: Pick<Dependencies, "db" | "hub" | "logger" | "machineAuth">,
  credential: string,
): Promise<EnrollmentBootstrap | null> {
  const enrollment = await findUnusedEnrollmentCredential(deps.db, credential);
  if (enrollment?.enrollSource !== "reconnect") return null;
  const host = getHost(deps.db, enrollment.hostId);
  if (!host || host.destroyedAt !== null || host.phase !== "active")
    return null;
  const grant = await serverAccess.repair(deps, {
    key: host.id,
    hostId: host.id,
    signal: AbortSignal.timeout(SERVER_ACCESS_TIMEOUT_MS),
  });
  return reconnectBootstrap(deps, {
    hostId: host.id,
    grant,
    credential,
    expiresAt: enrollment.expiresAt,
  });
}
