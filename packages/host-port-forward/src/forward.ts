import net from "node:net";
import { HOST_PORT_RELAY_CLOSE_REASONS } from "@bb/server-contract";
import { WebSocket, type ClientOptions } from "ws";

const FIN_FRAME = "fin";
const FRAME_MAX_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
const DRAIN_POLL_MS = 25;
const OPEN_STATE = 1;
const PROBE_TIMEOUT_MS = 1_000;
const FREE_PORT_ATTEMPTS = 10;
const LOOPBACKS = ["127.0.0.1", "::1"] as const;

type Loopback = (typeof LOOPBACKS)[number];

export interface HostPortForwardError {
  code: string;
  message: string;
  fatal: boolean;
}

export class HostPortBusyError extends Error {
  readonly code = "local_port_busy";

  constructor(readonly port: number) {
    super(
      `Local port ${port} is already in use on this computer (127.0.0.1 or ::1).`,
    );
    this.name = "HostPortBusyError";
  }
}

export interface ForwardHostPortOptions {
  relayUrl: string;
  localPort?: number;
  fallbackWhenBusy?: boolean;
  bindHost?: Loopback;
  headers?: Record<string, string>;
  agent?: ClientOptions["agent"];
  onError?: (error: HostPortForwardError) => void;
  onConnectionsChanged?: (count: number) => void;
}

export interface HostPortForward {
  readonly localPort: number;
  readonly localHost: string;
  connections(): number;
  close(): Promise<void>;
}

type CloseReason = (typeof HOST_PORT_RELAY_CLOSE_REASONS)[number];

const FATAL_CODES: ReadonlySet<string> = new Set<CloseReason>([
  "host_not_found",
  "invalid_port",
  "machine_credential",
]);

const CLOSE_MESSAGES: Record<CloseReason, string> = {
  error: "The machine could not connect to the port.",
  frame_too_large: "The relay received a frame that is too large.",
  idle: "The relay closed an idle connection.",
  host_not_found: "The server has no such machine.",
  host_offline: "The machine is offline.",
  invalid_port: "The port must be an integer from 1 to 65535.",
  limit: "Too many forwarded connections are open.",
  machine_credential:
    "The server does not let a machine credential open port relays. Use the desktop app or a direct server URL.",
  refused: "Nothing is listening on that port on the machine.",
  relay_limit: "Too many forwarded connections are open.",
  timeout: "The machine did not connect to the port in time.",
};

function describeClose(
  code: number,
  reason: string,
): HostPortForwardError | null {
  if (code === 1000 || code === 1005) return null;
  const given = reason === "" ? "error" : reason;
  const known = HOST_PORT_RELAY_CLOSE_REASONS.find((value) => value === given);
  return {
    code: given,
    message:
      known === undefined
        ? `The relay closed the connection (${given}).`
        : CLOSE_MESSAGES[known],
    fatal: FATAL_CODES.has(given),
  };
}

function refusalHint(status: number): string {
  if (status < 400)
    return " Something other than the bb relay answered, such as a sign-in page.";
  if (status === 401 || status === 403)
    return " The server or a proxy in front of it does not accept this address, origin or sign-in.";
  if (status === 404) return " This server may not support port forwarding.";
  return "";
}

function readUnexpectedResponse(
  status: number | undefined,
): HostPortForwardError {
  return {
    code: "relay_unreachable",
    message: `The server refused the relay (HTTP ${status ?? "?"}).${status === undefined ? "" : refusalHint(status)}`,
    fatal:
      status !== undefined &&
      (status < 400 || status === 401 || status === 403 || status === 404),
  };
}

function accepts(port: number, host: Loopback): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (held: boolean) => {
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(true));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function listen(
  server: net.Server,
  port: number,
  host: Loopback,
): Promise<"listening" | "busy" | "unavailable"> {
  return new Promise((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve("busy");
      else if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")
        resolve("unavailable");
      else reject(error);
    };
    server.once("error", failed);
    server.listen({ port, host }, () => {
      server.off("error", failed);
      resolve("listening");
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

interface Listeners {
  port: number;
  servers: net.Server[];
}

async function bindLoopbacks(
  port: number,
  bindHost: Loopback,
  handle: (socket: net.Socket) => void,
): Promise<Listeners | null> {
  const primary = net.createServer({ allowHalfOpen: true }, handle);
  const bound = await listen(primary, port, bindHost);
  if (bound === "busy") return null;
  if (bound === "unavailable")
    throw new Error(`This computer cannot listen on ${bindHost}.`);
  const address = primary.address();
  const localPort =
    typeof address === "object" && address !== null ? address.port : port;
  const other: Loopback = bindHost === "127.0.0.1" ? "::1" : "127.0.0.1";
  const secondary = net.createServer({ allowHalfOpen: true }, handle);
  const second = await listen(secondary, localPort, other);
  if (second === "busy") {
    await closeServer(primary);
    return null;
  }
  if (second === "unavailable") return { port: localPort, servers: [primary] };
  if (bindHost === "127.0.0.1")
    return { port: localPort, servers: [primary, secondary] };
  await closeServer(secondary);
  return { port: localPort, servers: [primary] };
}

async function bindRequestedPort(
  port: number,
  bindHost: Loopback,
  handle: (socket: net.Socket) => void,
): Promise<Listeners | null> {
  const held = await Promise.all(LOOPBACKS.map((host) => accepts(port, host)));
  return held.includes(true) ? null : bindLoopbacks(port, bindHost, handle);
}

async function bindFreePort(
  bindHost: Loopback,
  handle: (socket: net.Socket) => void,
): Promise<Listeners> {
  for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt += 1) {
    const listeners = await bindLoopbacks(0, bindHost, handle);
    if (listeners !== null) return listeners;
  }
  throw new Error("No local port is free on both loopback addresses.");
}

export async function forwardHostPort(
  options: ForwardHostPortOptions,
): Promise<HostPortForward> {
  const sockets = new Set<net.Socket>();
  const bindHost = options.bindHost ?? "127.0.0.1";
  const reportConnections = () => options.onConnectionsChanged?.(sockets.size);

  const handle = (socket: net.Socket): void => {
    sockets.add(socket);
    reportConnections();
    socket.pause();
    const ws = new WebSocket(options.relayUrl, {
      agent: options.agent,
      headers: options.headers,
      maxPayload: FRAME_MAX_BYTES,
      perMessageDeflate: false,
    });
    let finished = false;
    let reported = false;
    let responding = false;
    const report = (error: HostPortForwardError): void => {
      if (reported) return;
      reported = true;
      options.onError?.(error);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (ws.readyState === OPEN_STATE) ws.close(1000);
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    };
    socket.once("close", () => {
      sockets.delete(socket);
      reportConnections();
      finish();
    });
    socket.on("error", finish);

    ws.once("open", () => socket.resume());
    ws.once("unexpected-response", (_request, response) => {
      responding = true;
      report(readUnexpectedResponse(response.statusCode));
      response.resume();
      finish();
    });
    ws.on("error", () => finish());
    ws.on("close", (code: number, reason: Buffer) => {
      const failure = describeClose(code, reason.toString("utf8"));
      if (failure !== null && !responding) report(failure);
      finish();
    });

    socket.on("data", (chunk: Buffer) => {
      if (ws.readyState !== OPEN_STATE) return;
      for (let offset = 0; offset < chunk.length; offset += FRAME_MAX_BYTES)
        ws.send(chunk.subarray(offset, offset + FRAME_MAX_BYTES));
      if (ws.bufferedAmount > HIGH_WATER_BYTES) {
        socket.pause();
        const timer = setInterval(() => {
          if (finished) {
            clearInterval(timer);
            return;
          }
          if (ws.bufferedAmount > LOW_WATER_BYTES) return;
          clearInterval(timer);
          socket.resume();
        }, DRAIN_POLL_MS);
      }
    });
    socket.on("end", () => {
      if (ws.readyState === OPEN_STATE) ws.send(FIN_FRAME);
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        if (data.toString("utf8") === FIN_FRAME) socket.end();
        return;
      }
      if (!socket.write(data)) {
        ws.pause();
        socket.once("drain", () => ws.resume());
      }
    });
  };

  const requested = options.localPort ?? 0;
  let listeners =
    requested === 0
      ? await bindFreePort(bindHost, handle)
      : await bindRequestedPort(requested, bindHost, handle);
  if (listeners === null && options.fallbackWhenBusy === true)
    listeners = await bindFreePort(bindHost, handle);
  if (listeners === null) throw new HostPortBusyError(requested);
  const { port: localPort, servers } = listeners;

  return {
    localPort,
    localHost: bindHost,
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(closeServer));
    },
  };
}
