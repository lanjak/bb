import { Command } from "commander";
import {
  experimental_forwardHostPort,
  HostPortBusyError,
  HostPortRelayAccessError,
} from "@bb/sdk/node";
import { action, CliExitError, CliUsageError } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "../command-result.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";

interface MachineForwardOptions {
  bind: string;
  host?: string;
  json?: boolean;
  machine?: string;
  thread?: string;
}

interface ForwardPorts {
  port: number;
  localPort: number;
}

const LOOPBACK_BINDS = ["127.0.0.1", "::1", "localhost"] as const;

function parsePortNumber(value: string, label: string, minimum = 1): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/u.test(value) || parsed < minimum || parsed > 65535)
    throw new CliUsageError({
      code: "invalid_value",
      hint: null,
      message: `${label} must be an integer from ${minimum} to 65535, got '${value}'.`,
    });
  return parsed;
}

export function parseForwardPorts(spec: string): ForwardPorts {
  const parts = spec.split(":");
  if (parts.length > 2)
    throw new CliUsageError({
      code: "invalid_value",
      hint: "Use <port> or <port>:<local-port>.",
      message: `Not a port mapping: '${spec}'.`,
    });
  const port = parsePortNumber(parts[0] ?? "", "The port");
  return {
    port,
    localPort:
      parts[1] === undefined
        ? port
        : parsePortNumber(parts[1], "The local port", 0),
  };
}

export function parseBindAddress(value: string): "127.0.0.1" | "::1" {
  if (!LOOPBACK_BINDS.some((allowed) => allowed === value))
    throw new CliUsageError({
      code: "invalid_value",
      hint: "A forward listens on loopback only, so other devices cannot use it.",
      message: `--bind must be a loopback address (${LOOPBACK_BINDS.join(", ")}), got '${value}'.`,
    });
  return value === "::1" ? "::1" : "127.0.0.1";
}

function startFailure(error: unknown, ports: ForwardPorts): CliExitError {
  if (error instanceof HostPortBusyError)
    return new CliExitError(error.message, 1, {
      code: error.code,
      hint: `Pass ${ports.port}:<local-port> for another local port, or ${ports.port}:0 for a free one.`,
    });
  if (error instanceof HostPortRelayAccessError)
    return new CliExitError(error.message, 1, {
      code: error.code,
      hint: null,
    });
  return new CliExitError(
    error instanceof Error ? error.message : String(error),
    1,
    { code: "forward_failed", hint: null },
  );
}

async function resolveForwardHost(
  options: MachineForwardOptions,
  getUrl: () => string,
): Promise<string> {
  const machine = resolveMachineTargetOption({
    machine: options.machine,
    host: options.host,
  });
  if ((machine === undefined) === (options.thread === undefined))
    throw new CliUsageError({
      code: machine === undefined ? "missing_required" : "invalid_value",
      hint: "For example: bb machine forward 5173 --thread <thread-id>",
      message: "Provide exactly one of --machine/--host or --thread.",
    });
  if (machine !== undefined)
    return resolveMachineHostId({ serverUrl: getUrl(), target: machine });
  const sdk = createCliBbSdk(getUrl());
  const thread = await sdk.threads.get({ threadId: options.thread! });
  if (thread.environmentId === null)
    throw new CliExitError(
      "The thread has no environment, so it has no machine.",
      1,
      {
        code: "no_environment",
        hint: null,
      },
    );
  return (await sdk.environments.get({ environmentId: thread.environmentId }))
    .hostId;
}

export function registerMachineForwardCommand(
  machine: Command,
  getUrl: () => string,
): void {
  machine
    .command("forward")
    .description(
      "Forward a local port to a loopback port on a machine, like ssh -L",
    )
    .argument(
      "<port>",
      "Port on the machine, or <port>:<local-port> (local port 0 picks a free one)",
    )
    .option("--machine <id-or-name>", "Machine to forward from")
    .option("--host <id-or-name>", "Alias for --machine")
    .option(
      "--thread <id>",
      "Forward from the machine of this thread's environment",
    )
    .option(
      "--bind <address>",
      "Local address to listen on (loopback only)",
      "127.0.0.1",
    )
    .option("--json", "Print machine-readable JSON output when it starts")
    .addHelpText(
      "after",
      "\nThe forward listens on the same local port as the machine's unless you pass <port>:<local-port>, and it fails when that local port is busy. It runs until Ctrl-C. Any process on this computer can connect to the local port, and a browser sends its cookies for localhost:<port> to the remote service. Any client that can reach and sign in to the bb server can forward the loopback ports of every enrolled machine. A machine that reaches the server through bb Connect cannot run this command; use the desktop app or a direct server URL.",
    )
    .action(
      action(async (spec: string, options: MachineForwardOptions) => {
        const ports = parseForwardPorts(spec);
        const bindHost = parseBindAddress(options.bind);
        const serverUrl = getUrl();
        const hostId = await resolveForwardHost(options, getUrl);
        const sdk = createCliBbSdk(serverUrl);
        const host = await sdk.hosts.get({ hostId });
        const stopped = new Promise<CliExitError | null>((resolve) => {
          void experimental_forwardHostPort({
            sdk,
            hostId,
            port: ports.port,
            localPort: ports.localPort,
            bindHost,
            onError: (error) => {
              console.error(`${error.code}: ${error.message}`);
              if (error.fatal)
                resolve(
                  new CliExitError(error.message, 1, {
                    code: error.code,
                    hint: null,
                  }),
                );
            },
          })
            .then((forward) => {
              if (
                !outputJson(options, {
                  hostId,
                  hostName: host.name,
                  port: ports.port,
                  localPort: forward.localPort,
                  bind: forward.localHost,
                })
              )
                console.log(
                  `Forwarding ${forward.localHost === "::1" ? "[::1]" : "localhost"}:${forward.localPort} -> ${host.name}:${ports.port} (Ctrl-C to stop)`,
                );
              const stop = () => {
                void forward.close().then(() => resolve(null));
              };
              process.once("SIGINT", stop);
              process.once("SIGTERM", stop);
              if (host.status !== "connected")
                console.error(
                  `${host.name} is ${host.status}; connections fail until it is connected.`,
                );
            })
            .catch((error: unknown) => {
              resolve(startFailure(error, ports));
            });
        });
        const failure = await stopped;
        if (failure !== null) throw failure;
      }),
    );
}
