import net from "node:net";
import {
  HOST_PORT_RELAY_FRAME_MAX_BYTES,
  HOST_PORT_RELAY_TOKEN_HEADER,
  buildHostDaemonWebSocketAuthorizationHeader,
  hostPortRelayDaemonPath,
  type HostPortConnectFailedMessage,
  type HostPortConnectFailureCode,
  type HostPortConnectMessage,
} from "@bb/host-daemon-contract";
import { WebSocket } from "ws";
import type { HostDaemonLogger } from "../logger.js";
import { webSocketAgent } from "../websocket-constructor.js";

export interface HostPortRelayDaemonLimits {
  maxRelays: number;
  dialTimeoutMs: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  drainPollMs: number;
}

export const HOST_PORT_RELAY_DAEMON_LIMITS: HostPortRelayDaemonLimits = {
  maxRelays: 256,
  dialTimeoutMs: 10_000,
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  drainPollMs: 25,
};

const FIN_FRAME = "fin";
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;

export interface HostPortRelayManagerOptions {
  serverUrl: string;
  hostKey: string;
  serverHeaders: Record<string, string>;
  logger: HostDaemonLogger;
  sendToServer(message: HostPortConnectFailedMessage): void;
  dial?: (port: number, address: string) => Promise<net.Socket>;
  limits?: Partial<HostPortRelayDaemonLimits>;
}

class DialFailure extends Error {
  constructor(
    readonly code: HostPortConnectFailureCode,
    message: string,
  ) {
    super(message);
  }
}

function dialLoopback(
  port: number,
  address: string,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new DialFailure("timeout", `Dialing ${address}:${port} timed out`),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        new DialFailure(
          error.code === "ECONNREFUSED" ? "refused" : "error",
          error.code ?? "connection failed",
        ),
      );
    });
  });
}

function relayWebSocketUrl(serverUrl: string, relayId: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = hostPortRelayDaemonPath(relayId);
  url.search = "";
  return url.toString();
}

export class HostPortRelayManager {
  private readonly open = new Set<net.Socket>();
  private readonly limits: HostPortRelayDaemonLimits;

  constructor(private readonly options: HostPortRelayManagerOptions) {
    this.limits = { ...HOST_PORT_RELAY_DAEMON_LIMITS, ...options.limits };
  }

  count(): number {
    return this.open.size;
  }

  async connect(message: HostPortConnectMessage): Promise<void> {
    if (this.open.size >= this.limits.maxRelays) {
      this.fail(
        message,
        "limit",
        "Too many forwarded connections on this machine",
      );
      return;
    }
    let socket: net.Socket;
    try {
      socket = await this.dialAny(message.port);
    } catch (error) {
      const failure =
        error instanceof DialFailure
          ? error
          : new DialFailure("error", "connection failed");
      this.fail(message, failure.code, failure.message);
      return;
    }
    socket.pause();
    this.open.add(socket);
    socket.once("close", () => this.open.delete(socket));
    this.splice(message, socket);
  }

  closeAll(): void {
    for (const socket of this.open) socket.destroy();
    this.open.clear();
  }

  private async dialAny(port: number): Promise<net.Socket> {
    const dial =
      this.options.dial ??
      ((target: number, address: string) =>
        dialLoopback(target, address, this.limits.dialTimeoutMs));
    let last: unknown = null;
    for (const address of LOOPBACK_ADDRESSES) {
      try {
        return await dial(port, address);
      } catch (error) {
        last = error;
        if (error instanceof DialFailure && error.code === "timeout")
          throw error;
      }
    }
    throw last;
  }

  private fail(
    message: HostPortConnectMessage,
    code: HostPortConnectFailureCode,
    detail: string,
  ): void {
    this.options.logger.info(
      { relayId: message.relayId, port: message.port, code },
      "Host port relay could not connect",
    );
    this.options.sendToServer({
      type: "host-port.connect-failed",
      relayId: message.relayId,
      code,
      message: detail.slice(0, 200),
    });
  }

  private splice(message: HostPortConnectMessage, socket: net.Socket): void {
    const url = relayWebSocketUrl(this.options.serverUrl, message.relayId);
    const ws = new WebSocket(url, {
      agent: webSocketAgent(url),
      headers: {
        authorization: buildHostDaemonWebSocketAuthorizationHeader(
          this.options.hostKey,
        ),
        ...this.options.serverHeaders,
        [HOST_PORT_RELAY_TOKEN_HEADER]: message.token,
      },
      maxPayload: HOST_PORT_RELAY_FRAME_MAX_BYTES,
      perMessageDeflate: false,
    });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    };

    ws.once("open", () => socket.resume());
    ws.once("error", (error) => {
      this.options.logger.warn(
        { relayId: message.relayId, error: String(error) },
        "Host port relay dial-back failed",
      );
      finish();
    });
    ws.once("close", finish);

    socket.on("data", (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      for (
        let offset = 0;
        offset < chunk.length;
        offset += HOST_PORT_RELAY_FRAME_MAX_BYTES
      )
        ws.send(
          chunk.subarray(offset, offset + HOST_PORT_RELAY_FRAME_MAX_BYTES),
        );
      if (ws.bufferedAmount > this.limits.highWaterBytes) {
        socket.pause();
        const timer = setInterval(() => {
          if (finished) {
            clearInterval(timer);
            return;
          }
          if (ws.bufferedAmount > this.limits.lowWaterBytes) return;
          clearInterval(timer);
          socket.resume();
        }, this.limits.drainPollMs);
      }
    });
    socket.on("end", () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(FIN_FRAME);
    });
    socket.on("error", finish);
    socket.on("close", finish);

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
  }
}
