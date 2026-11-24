import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  HOST_PORT_RELAY_FRAME_MAX_BYTES,
  hostPortConnectFailureCodeSchema,
  type HostPortConnectFailedMessage,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  HOST_PORT_RELAY_REFUSED_CLOSE_CODE,
  type HostPortRelayRefusal,
} from "@bb/server-contract";
import type { WSMessageReceive } from "hono/ws";

export interface HostPortRelayLimits {
  perHost: number;
  perPrincipal: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  tokenTtlMs: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  pendingClientBytes: number;
  drainPollMs: number;
}

export const HOST_PORT_RELAY_LIMITS: HostPortRelayLimits = {
  perHost: 256,
  perPrincipal: 64,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 10 * 60_000,
  tokenTtlMs: 10_000,
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  pendingClientBytes: 1024 * 1024,
  drainPollMs: 25,
};

const CLOSE_NORMAL = 1000;
const CLOSE_TOO_BIG = 1009;
const CLOSE_ERROR = 1011;
const OPEN = 1;

export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(
    data: ArrayBuffer | Uint8Array | string,
    options: { binary: boolean },
    callback?: (error?: Error) => void,
  ): void;
  close(code?: number, reason?: string): void;
  pause(): void;
  resume(): void;
}

export function isRelaySocket(value: unknown): value is RelaySocket {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.send === "function" &&
    typeof candidate.close === "function" &&
    typeof candidate.pause === "function" &&
    typeof candidate.resume === "function"
  );
}

export interface HostPortRelayHub {
  getDaemonSessionIdForHost(hostId: string): string | null;
  sendDaemonMessage(
    hostId: string,
    message: HostDaemonServerWsMessage,
  ): boolean;
}

export interface HostPortRelayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface HostPortRelayOptions {
  hub: HostPortRelayHub;
  logger: HostPortRelayLogger;
  now?: () => number;
  limits?: Partial<HostPortRelayLimits>;
}

interface Relay {
  id: string;
  hostId: string;
  port: number;
  principal: string | null;
  token: Buffer;
  tokenExpiresAt: number;
  client: RelaySocket;
  daemon: RelaySocket | null;
  pending: Array<{ data: ArrayBuffer | string; binary: boolean }>;
  pendingBytes: number;
  connectTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  drainTimers: Set<ReturnType<typeof setInterval>>;
  bytesToHost: number;
  bytesFromHost: number;
  closed: boolean;
}

export interface ClientRelayEvents {
  onOpen(socket: RelaySocket): void;
  onMessage(data: WSMessageReceive): void;
  onClose(): void;
}

export interface HostPortRelayClient {
  hostId: string;
  port: number;
  principal: string | null;
}

function sameToken(expected: Buffer, presented: string): boolean {
  const actual = Buffer.from(presented, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function dataSize(data: ArrayBuffer | string): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

function frameOf(data: WSMessageReceive): ArrayBuffer | string | null {
  return typeof data === "string" || data instanceof ArrayBuffer ? data : null;
}

export class HostPortRelays {
  private readonly relays = new Map<string, Relay>();
  private readonly limits: HostPortRelayLimits;
  private readonly now: () => number;

  constructor(private readonly options: HostPortRelayOptions) {
    this.limits = { ...HOST_PORT_RELAY_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  count(): number {
    return this.relays.size;
  }

  client(args: HostPortRelayClient): ClientRelayEvents {
    let relay: Relay | null = null;
    return {
      onOpen: (socket) => {
        const refusal = this.admissionRefusal(args);
        if (refusal !== null) {
          this.refuseSocket(socket, refusal, args);
          return;
        }
        relay = this.register(args, socket);
      },
      onMessage: (data) => {
        if (relay !== null) this.fromClient(relay, data);
      },
      onClose: () => {
        if (relay !== null) this.close(relay, null);
      },
    };
  }

  refuse(
    reason: HostPortRelayRefusal,
    args: { hostId: string },
  ): ClientRelayEvents {
    return {
      onOpen: (socket) => this.refuseSocket(socket, reason, args),
      onMessage: () => undefined,
      onClose: () => undefined,
    };
  }

  private refuseSocket(
    socket: RelaySocket,
    reason: HostPortRelayRefusal,
    args: { hostId: string },
  ): void {
    this.options.logger.info(
      { hostId: args.hostId, reason },
      "Refused a host port relay",
    );
    socket.close(HOST_PORT_RELAY_REFUSED_CLOSE_CODE, reason);
  }

  private admissionRefusal(
    args: HostPortRelayClient,
  ): HostPortRelayRefusal | null {
    if (this.options.hub.getDaemonSessionIdForHost(args.hostId) === null)
      return "host_offline";
    let onHost = 0;
    let ofPrincipal = 0;
    for (const relay of this.relays.values()) {
      if (relay.hostId === args.hostId) onHost += 1;
      if (args.principal !== null && relay.principal === args.principal)
        ofPrincipal += 1;
    }
    return onHost >= this.limits.perHost ||
      ofPrincipal >= this.limits.perPrincipal
      ? "relay_limit"
      : null;
  }

  private register(args: HostPortRelayClient, client: RelaySocket): Relay {
    const relay: Relay = {
      id: randomBytes(18).toString("base64url"),
      hostId: args.hostId,
      port: args.port,
      principal: args.principal,
      token: Buffer.from(randomBytes(32).toString("base64url"), "utf8"),
      tokenExpiresAt: this.now() + this.limits.tokenTtlMs,
      client,
      daemon: null,
      pending: [],
      pendingBytes: 0,
      connectTimer: null,
      idleTimer: null,
      drainTimers: new Set(),
      bytesToHost: 0,
      bytesFromHost: 0,
      closed: false,
    };
    this.relays.set(relay.id, relay);
    const sent = this.options.hub.sendDaemonMessage(relay.hostId, {
      type: "host-port.connect",
      relayId: relay.id,
      port: relay.port,
      token: relay.token.toString("utf8"),
    });
    if (!sent) {
      this.close(relay, { code: CLOSE_ERROR, reason: "host_offline" });
      return relay;
    }
    relay.connectTimer = setTimeout(() => {
      this.close(relay, { code: CLOSE_ERROR, reason: "timeout" });
    }, this.limits.connectTimeoutMs);
    return relay;
  }

  private fromClient(relay: Relay, data: WSMessageReceive): void {
    const frame = frameOf(data);
    if (relay.closed || frame === null) return;
    if (this.rejectOversized(relay, frame)) return;
    this.touch(relay);
    if (relay.daemon === null) {
      relay.pendingBytes += dataSize(frame);
      if (relay.pendingBytes > this.limits.pendingClientBytes) {
        this.close(relay, { code: CLOSE_TOO_BIG, reason: "limit" });
        return;
      }
      relay.pending.push({ data: frame, binary: typeof frame !== "string" });
      return;
    }
    relay.bytesToHost += dataSize(frame);
    this.pump(relay, relay.client, relay.daemon, frame);
  }

  attachDaemon(args: {
    relayId: string;
    hostId: string;
    token: string;
    socket: RelaySocket;
  }): {
    onMessage(data: WSMessageReceive): void;
    onClose(): void;
  } {
    const relay = this.relays.get(args.relayId);
    if (
      relay === undefined ||
      relay.closed ||
      relay.hostId !== args.hostId ||
      relay.daemon !== null ||
      this.now() > relay.tokenExpiresAt ||
      !sameToken(relay.token, args.token)
    ) {
      args.socket.close(CLOSE_ERROR, "unknown relay");
      this.options.logger.warn(
        { hostId: args.hostId, relayId: args.relayId },
        "Rejected a host port relay dial-back",
      );
      return { onMessage: () => undefined, onClose: () => undefined };
    }
    relay.daemon = args.socket;
    if (relay.connectTimer !== null) clearTimeout(relay.connectTimer);
    relay.connectTimer = null;
    this.touch(relay);
    const pending = relay.pending.splice(0);
    relay.pendingBytes = 0;
    for (const frame of pending) {
      relay.bytesToHost += dataSize(frame.data);
      this.pump(relay, relay.client, args.socket, frame.data);
    }
    return {
      onMessage: (data) => {
        const frame = frameOf(data);
        if (relay.closed || frame === null) return;
        if (this.rejectOversized(relay, frame)) return;
        this.touch(relay);
        relay.bytesFromHost += dataSize(frame);
        this.pump(relay, args.socket, relay.client, frame);
      },
      onClose: () => this.close(relay, null),
    };
  }

  connectFailed(hostId: string, message: HostPortConnectFailedMessage): void {
    const relay = this.relays.get(message.relayId);
    if (relay === undefined || relay.hostId !== hostId || relay.daemon !== null)
      return;
    const code = hostPortConnectFailureCodeSchema.safeParse(message.code);
    this.close(relay, {
      code: CLOSE_ERROR,
      reason: code.success ? code.data : "error",
    });
  }

  private rejectOversized(relay: Relay, frame: ArrayBuffer | string): boolean {
    if (dataSize(frame) <= HOST_PORT_RELAY_FRAME_MAX_BYTES) return false;
    this.close(relay, { code: CLOSE_TOO_BIG, reason: "frame_too_large" });
    return true;
  }

  private touch(relay: Relay): void {
    if (relay.idleTimer !== null) clearTimeout(relay.idleTimer);
    relay.idleTimer = setTimeout(() => {
      this.close(relay, { code: CLOSE_NORMAL, reason: "idle" });
    }, this.limits.idleTimeoutMs);
  }

  private pump(
    relay: Relay,
    from: RelaySocket | null,
    to: RelaySocket | null,
    data: ArrayBuffer | string,
  ): void {
    if (to === null || to.readyState !== OPEN) return;
    try {
      to.send(data, { binary: typeof data !== "string" });
    } catch {
      this.close(relay, { code: CLOSE_ERROR, reason: "error" });
      return;
    }
    if (from === null || to.bufferedAmount < this.limits.highWaterBytes) return;
    from.pause();
    const timer = setInterval(() => {
      if (relay.closed || to.readyState !== OPEN) {
        clearInterval(timer);
        relay.drainTimers.delete(timer);
        return;
      }
      if (to.bufferedAmount > this.limits.lowWaterBytes) return;
      clearInterval(timer);
      relay.drainTimers.delete(timer);
      from.resume();
    }, this.limits.drainPollMs);
    relay.drainTimers.add(timer);
  }

  private close(
    relay: Relay,
    closing: { code: number; reason: string } | null,
  ): void {
    if (relay.closed) return;
    relay.closed = true;
    this.relays.delete(relay.id);
    if (relay.connectTimer !== null) clearTimeout(relay.connectTimer);
    if (relay.idleTimer !== null) clearTimeout(relay.idleTimer);
    for (const timer of relay.drainTimers) clearInterval(timer);
    relay.drainTimers.clear();
    const code = closing?.code ?? CLOSE_NORMAL;
    const reason = closing?.reason ?? "";
    for (const socket of [relay.client, relay.daemon]) {
      if (socket === null) continue;
      try {
        socket.close(code, reason);
      } catch {
        continue;
      }
    }
    this.options.logger.info(
      {
        hostId: relay.hostId,
        port: relay.port,
        bytesToHost: relay.bytesToHost,
        bytesFromHost: relay.bytesFromHost,
        code,
        reason,
      },
      "Host port relay closed",
    );
  }
}
