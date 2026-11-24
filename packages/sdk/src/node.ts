import { loadCliConfig, type CliConfig } from "@bb/config/cli";
import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
} from "@bb/host-daemon-contract";
import {
  forwardHostPort,
  type ForwardHostPortOptions,
  type HostPortForward,
} from "@bb/host-port-forward";
import { BbHttpError } from "./http-error.js";
import { createGuideArea } from "./areas/guide.js";
import { createBbSdk, type BbSdk, type BbSdkAreas } from "./core.js";
import { createNodeWebsocketFactory } from "./node-websocket.js";
import {
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./response.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  BbRealtimeSocketFactory,
  BbSdkContext,
  BbSdkTransport,
} from "./transport.js";

export interface CreateNodeTransportArgs {
  baseUrl?: string;
  cliConfig?: CliConfig;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  timeoutMs?: number;
  websocket?: BbRealtimeSocketFactory;
}

export interface CreateNodeBbSdkArgs extends CreateNodeTransportArgs {
  context?: BbSdkContext;
}

export interface FetchLocalHostIdArgs {
  cliConfig?: CliConfig;
  hostDaemonUrl?: string;
}

function resolveCliConfig(cliConfig?: CliConfig): CliConfig {
  return cliConfig ?? loadCliConfig();
}

function resolveHostDaemonUrl(cliConfig?: CliConfig): string {
  const config = resolveCliConfig(cliConfig);
  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${config.BB_HOST_DAEMON_PORT}`;
}

export function createNodeTransport(
  args: CreateNodeTransportArgs = {},
): BbSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl ?? resolveCliConfig(args.cliConfig).BB_SERVER_URL,
    fetch:
      args.fetch ??
      createRequestTimeoutFetch({
        timeoutMs: args.timeoutMs ?? DEFAULT_BB_REQUEST_TIMEOUT_MS,
      }),
    realtimeUrl: args.realtimeUrl,
    runtime: "node",
    websocket: args.websocket ?? createNodeWebsocketFactory(),
  });
}

export function createNodeBbSdk(args: CreateNodeBbSdkArgs = {}): BbSdk {
  return createBbSdk({
    context: args.context,
    guide: createGuideArea(),
    transport: createNodeTransport(args),
  });
}

export async function fetchLocalHostId(
  args: FetchLocalHostIdArgs = {},
): Promise<string | null> {
  try {
    const client = createHostDaemonLocalClient(
      args.hostDaemonUrl ?? resolveHostDaemonUrl(args.cliConfig),
    );
    const response = await client.status.$get();
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body.hostId;
  } catch {
    return null;
  }
}

export interface ForwardHostPortArgs {
  sdk: BbSdk;
  hostId: string;
  port: number;
  localPort?: number;
  bindHost?: ForwardHostPortOptions["bindHost"];
  onError?: ForwardHostPortOptions["onError"];
  onConnectionsChanged?: ForwardHostPortOptions["onConnectionsChanged"];
}

export class HostPortRelayAccessError extends Error {
  constructor(
    readonly code: "machine_credential" | "port_relay_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "HostPortRelayAccessError";
  }
}

async function assertPortRelayAccess(sdk: BbSdk): Promise<void> {
  const access = await sdk.hosts
    .experimental_portRelayAccess()
    .catch((error: unknown) => {
      if (error instanceof BbHttpError && error.status === 404)
        throw new HostPortRelayAccessError(
          "port_relay_unsupported",
          "This bb server does not support port forwarding. Update it first.",
        );
      throw error;
    });
  if (!access.allowed)
    throw new HostPortRelayAccessError(
      "machine_credential",
      "Port forwarding does not work with a machine credential, which is how a machine enrolled through bb Connect reaches the server. Use the desktop app, or set BB_SERVER_URL to a direct server URL.",
    );
}

export async function experimental_forwardHostPort(
  args: ForwardHostPortArgs,
): Promise<HostPortForward> {
  await assertPortRelayAccess(args.sdk);
  return forwardHostPort({
    relayUrl: args.sdk.hosts.experimental_portRelayUrl({
      hostId: args.hostId,
      port: args.port,
    }),
    localPort: args.localPort ?? args.port,
    bindHost: args.bindHost,
    onError: args.onError,
    onConnectionsChanged: args.onConnectionsChanged,
  });
}

export { HostPortBusyError } from "@bb/host-port-forward";
export type {
  ForwardHostPortOptions,
  HostPortForward,
  HostPortForwardError,
} from "@bb/host-port-forward";

export {
  createBbSdk,
  createHttpTransport,
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
};
export { BbHttpError };
export { BbRequestTimeoutError } from "./response.js";
export {
  pluginMutationResponseSchema,
  type PluginMutationResponse,
} from "./areas/plugins.js";
export { createBuiltinPlanCommandTextInput } from "./core.js";
export { createGuideArea } from "./areas/guide.js";
export { createRetiredEnvironmentMembers } from "./areas/retired-environment-members.js";
export {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
export type {
  BbSdk,
  BbSdkAreas,
  BbSdkContext,
  BbSdkTransport,
  FetchImplementation,
};
export type * from "./areas/skills.js";
export type {
  BbRealtimeSocket,
  BbRealtimeSocketFactory,
  BbRealtimeSocketMessageEvent,
} from "./transport.js";
export type { BbHttpErrorArgs } from "./http-error.js";
export type * from "./public-types.js";
