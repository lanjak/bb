import type { IncomingMessage } from "node:http";
import http from "node:http";
import net from "node:net";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  HOST_PORT_RELAY_TOKEN_HEADER,
  buildHostDaemonWebSocketProtocols,
  hostPortConnectMessageSchema,
  hostPortRelayDaemonPath,
  type HostPortConnectMessage,
} from "@bb/host-daemon-contract";
import { hostPortRelayPath } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  HostPortRelays,
  type RelaySocket,
} from "../../src/ws/host-port-relay.js";
import {
  createTestDaemonHostKey,
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

const sockets = new Set<WebSocket>();
const inbox = new WeakMap<WebSocket, Buffer[]>();
let server: RunningTestServer | null = null;

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (server !== null) {
    await server.close();
    server = null;
  }
});

function websocketUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.protocol = "ws:";
  return url.href;
}

function openSocket(
  url: string,
  options: { headers?: Record<string, string>; protocols?: string[] } = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options.protocols ?? [], {
      headers: options.headers,
    });
    sockets.add(socket);
    inbox.set(socket, []);
    socket.on("message", (data: Buffer) => inbox.get(socket)?.push(data));
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        reject(
          new Error(
            `${response.statusCode} ${Buffer.concat(chunks).toString("utf8")}`,
          ),
        ),
      );
    });
    socket.once("error", reject);
  });
}

async function openDaemonSession(
  running: RunningTestServer,
  hostId: string,
): Promise<{ authorization: string; control: WebSocket }> {
  const authorization = `Bearer ${createTestDaemonHostKey({ hostId })}`;
  const opened = await fetch(`${running.baseUrl}/internal/session/open`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      hostId,
      instanceId: `instance-${hostId}`,
      hostName: `Host ${hostId}`,
      hasMachineCredential: false,
      platform: "linux",
      dataDir: "/tmp/host-data",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      openThreadWork: [],
    }),
  });
  expect(opened.status).toBe(201);
  const { sessionId } = z
    .object({ sessionId: z.string() })
    .parse(await opened.json());
  const control = await openSocket(
    websocketUrl(running.baseUrl, `/internal/ws?sessionId=${sessionId}`),
    {
      headers: { authorization },
      protocols: buildHostDaemonWebSocketProtocols(),
    },
  );
  return { authorization, control };
}

function nextConnect(control: WebSocket): Promise<HostPortConnectMessage> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const frame = z
        .object({ message: z.unknown() })
        .safeParse(JSON.parse(data.toString("utf8")));
      if (!frame.success) return;
      const parsed = hostPortConnectMessageSchema.safeParse(frame.data.message);
      if (!parsed.success) return;
      control.off("message", onMessage);
      resolve(parsed.data);
    };
    control.on("message", onMessage);
  });
}

function dialBack(
  running: RunningTestServer,
  connect: HostPortConnectMessage,
  authorization: string,
  token = connect.token,
): Promise<WebSocket> {
  return openSocket(
    websocketUrl(running.baseUrl, hostPortRelayDaemonPath(connect.relayId)),
    { headers: { authorization, [HOST_PORT_RELAY_TOKEN_HEADER]: token } },
  );
}

async function nextData(socket: WebSocket): Promise<Buffer> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const next = inbox.get(socket)?.shift();
    if (next !== undefined) return next;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no data arrived");
}

function closeOf(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
  });
}

function rawUpgrade(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, baseUrl), {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    request.once("response", (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve({ status: 101, body: "" });
    });
    request.once("error", reject);
    request.end();
  });
}

function upgradeWithoutKey(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
): Promise<string> {
  const url = new URL(baseUrl);
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () =>
      socket.write(`${lines.join("\r\n")}\r\n\r\n`),
    );
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response.split("\r\n")[0] ?? ""));
  });
}

function refusalOf(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(baseUrl, path), { headers });
    sockets.add(socket);
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
    socket.once("error", reject);
  });
}

describe("host port relay routes", () => {
  it("refuses a relay request from a foreign origin, and from a page on another port", async () => {
    server = await startTestServer();
    await openDaemonSession(server, "host-1");
    const path = hostPortRelayPath("host-1", 5432);
    for (const origin of [
      "https://evil.example",
      "http://localhost:3999",
      "http://127.0.0.1:9",
    ]) {
      const result = await rawUpgrade(server.baseUrl, path, { Origin: origin });
      expect(result.status, origin).toBe(403);
    }
    expect(server.deps.hostPortRelays.count()).toBe(0);
  });

  it("accepts a client that sends no origin and one from the server's own origin", async () => {
    server = await startTestServer();
    const { control } = await openDaemonSession(server, "host-1");
    const connect = nextConnect(control);
    const client = await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 5432)),
    );
    expect((await connect).port).toBe(5432);
    client.close();
    const connectAgain = nextConnect(control);
    await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 5433)),
      { headers: { origin: server.baseUrl } },
    );
    expect((await connectAgain).port).toBe(5433);
  });

  it("refuses a bad port, an unknown machine and an offline machine with the reason, and registers nothing", async () => {
    server = await startTestServer();
    await openDaemonSession(server, "host-1");
    const refusal = (hostId: string, port: string) =>
      refusalOf(server!.baseUrl, `/ws/host-ports/${hostId}/${port}`);
    for (const port of ["0", "65536", "abc", "80.5", "-1", "1e3"]) {
      await expect(refusal("host-1", port), port).resolves.toEqual({
        code: 1008,
        reason: "invalid_port",
      });
    }
    await expect(refusal("host-none", "80")).resolves.toEqual({
      code: 1008,
      reason: "host_not_found",
    });
    const { control } = await openDaemonSession(server, "host-2");
    control.terminate();
    await expect
      .poll(async () => (await refusal("host-2", "80")).reason)
      .toBe("host_offline");
    expect(server.deps.hostPortRelays.count()).toBe(0);
  });

  it("refuses a relay from a machine credential, and says so on the access route", async () => {
    server = await startTestServer();
    const { control } = await openDaemonSession(server, "host-1");
    const asked: string[] = [];
    control.on("message", (data: Buffer) => asked.push(data.toString("utf8")));
    await expect(
      refusalOf(server.baseUrl, hostPortRelayPath("host-1", 5432), {
        "x-bb-gate-auth": "machine",
      }),
    ).resolves.toEqual({ code: 1008, reason: "machine_credential" });
    expect(server.deps.hostPortRelays.count()).toBe(0);
    expect(asked.some((frame) => frame.includes("host-port.connect"))).toBe(
      false,
    );
    const access = async (headers: Record<string, string>) =>
      (
        await fetch(`${server!.baseUrl}/api/v1/system/port-relay-access`, {
          headers,
        })
      ).json();
    await expect(access({ "x-bb-gate-auth": "machine" })).resolves.toEqual({
      allowed: false,
      reason: "machine_credential",
    });
    const allowed: Array<Record<string, string>> = [
      {},
      { "x-bb-gate-auth": "session" },
    ];
    for (const headers of allowed)
      await expect(access(headers)).resolves.toEqual({
        allowed: true,
        reason: null,
      });
  });

  it("keeps no relay for 70 upgrades that fail, and still opens the next one", async () => {
    server = await startTestServer();
    const { authorization, control } = await openDaemonSession(
      server,
      "host-1",
    );
    const session = { "x-bb-gate-auth": "session" };
    for (let index = 0; index < 70; index += 1)
      await expect(
        upgradeWithoutKey(
          server.baseUrl,
          hostPortRelayPath("host-1", 5432),
          session,
        ),
      ).resolves.toContain("400");
    expect(server.deps.hostPortRelays.count()).toBe(0);
    const pending = nextConnect(control);
    const client = await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 5432)),
      { headers: session },
    );
    const daemon = await dialBack(server, await pending, authorization);
    client.send(Buffer.from("after the failures"));
    await expect(nextData(daemon)).resolves.toEqual(
      Buffer.from("after the failures"),
    );
    expect(server.deps.hostPortRelays.count()).toBe(1);
  });

  it("closes a relay that sends a frame over 64 KiB, from either side", async () => {
    server = await startTestServer();
    const { authorization, control } = await openDaemonSession(
      server,
      "host-1",
    );
    for (const side of ["client", "daemon"] as const) {
      const pending = nextConnect(control);
      const client = await openSocket(
        websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 8080)),
      );
      const daemon = await dialBack(server, await pending, authorization);
      client.send(Buffer.alloc(64 * 1024));
      await expect(nextData(daemon)).resolves.toHaveLength(64 * 1024);
      const closed = closeOf(client);
      (side === "client" ? client : daemon).send(Buffer.alloc(64 * 1024 + 1));
      await expect(closed, side).resolves.toEqual({
        code: 1009,
        reason: "frame_too_large",
      });
    }
    expect(server.deps.hostPortRelays.count()).toBe(0);
  });

  it("joins a client to the daemon that dials back with the token, and splices bytes both ways", async () => {
    server = await startTestServer();
    const { authorization, control } = await openDaemonSession(
      server,
      "host-1",
    );
    const pending = nextConnect(control);
    const client = await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 8080)),
    );
    client.send(Buffer.from("early bytes"));
    const connect = await pending;
    const daemon = await dialBack(server, connect, authorization);
    await expect(nextData(daemon)).resolves.toEqual(Buffer.from("early bytes"));
    daemon.send(Buffer.from("response bytes"));
    await expect(nextData(client)).resolves.toEqual(
      Buffer.from("response bytes"),
    );
    const closed = closeOf(client);
    daemon.close(1000);
    await expect(closed).resolves.toMatchObject({ code: 1000 });
    await expect.poll(() => server!.deps.hostPortRelays.count()).toBe(0);
  });

  it("refuses a dial-back that reuses a token, uses a wrong one, or comes from another machine", async () => {
    server = await startTestServer();
    const first = await openDaemonSession(server, "host-1");
    const second = await openDaemonSession(server, "host-2");
    const pending = nextConnect(first.control);
    const client = await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 8080)),
    );
    const connect = await pending;

    const wrongToken = await dialBack(
      server,
      connect,
      first.authorization,
      "A".repeat(43),
    );
    await expect(closeOf(wrongToken)).resolves.toMatchObject({ code: 1011 });
    const otherHost = await dialBack(server, connect, second.authorization);
    await expect(closeOf(otherHost)).resolves.toMatchObject({ code: 1011 });

    const real = await dialBack(server, connect, first.authorization);
    const reused = await dialBack(server, connect, first.authorization);
    await expect(closeOf(reused)).resolves.toMatchObject({ code: 1011 });
    client.send(Buffer.from("still joined"));
    await expect(nextData(real)).resolves.toEqual(Buffer.from("still joined"));
  });

  it("refuses a dial-back with no daemon credential", async () => {
    server = await startTestServer();
    const { control } = await openDaemonSession(server, "host-1");
    const pending = nextConnect(control);
    await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 8080)),
    );
    const connect = await pending;
    const result = await rawUpgrade(
      server.baseUrl,
      hostPortRelayDaemonPath(connect.relayId),
      { [HOST_PORT_RELAY_TOKEN_HEADER]: connect.token },
    );
    expect(result.status).toBe(401);
  });

  it("closes the client when the machine cannot connect, with the reason", async () => {
    server = await startTestServer();
    const { control } = await openDaemonSession(server, "host-1");
    const pending = nextConnect(control);
    const client = await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 8080)),
    );
    const closed = closeOf(client);
    const connect = await pending;
    control.send(
      JSON.stringify({
        seq: 1,
        ack: 0,
        message: {
          type: "host-port.connect-failed",
          relayId: connect.relayId,
          code: "refused",
          message: "ECONNREFUSED",
        },
      }),
    );
    await expect(closed).resolves.toEqual({ code: 1011, reason: "refused" });
  });

  it("ignores a connect failure that comes from another machine", async () => {
    server = await startTestServer();
    const first = await openDaemonSession(server, "host-1");
    const second = await openDaemonSession(server, "host-2");
    const pending = nextConnect(first.control);
    const client = await openSocket(
      websocketUrl(server.baseUrl, hostPortRelayPath("host-1", 8080)),
    );
    const connect = await pending;
    second.control.send(
      JSON.stringify({
        seq: 1,
        ack: 0,
        message: {
          type: "host-port.connect-failed",
          relayId: connect.relayId,
          code: "refused",
          message: "forged",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(server.deps.hostPortRelays.count()).toBe(1);
  });
});

class FakeSocket implements RelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<ArrayBuffer | Uint8Array | string> = [];
  closed: { code?: number; reason?: string } | null = null;
  pauses = 0;
  resumes = 0;
  send(data: ArrayBuffer | Uint8Array | string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  pause(): void {
    this.pauses += 1;
  }
  resume(): void {
    this.resumes += 1;
  }
}

function fakeHub() {
  const messages: Array<{ hostId: string; message: HostPortConnectMessage }> =
    [];
  return {
    messages,
    hub: {
      getDaemonSessionIdForHost: (hostId: string) =>
        hostId === "offline" ? null : `session-${hostId}`,
      sendDaemonMessage: (
        hostId: string,
        message: { type: string } & Record<string, unknown>,
      ) => {
        messages.push({
          hostId,
          message: message as unknown as HostPortConnectMessage,
        });
        return true;
      },
    },
  };
}

const quietLogger = { info: () => undefined, warn: () => undefined };

describe("HostPortRelays limits", () => {
  function opened(
    relays: HostPortRelays,
    hostId: string,
    principal: string | null,
  ) {
    const socket = new FakeSocket();
    const events = relays.client({ hostId, port: 1, principal });
    events.onOpen(socket);
    return { socket, events };
  }

  it("limits the relays of one machine and of one signed-in principal, and frees a slot when one closes", () => {
    const { hub } = fakeHub();
    const relays = new HostPortRelays({
      hub,
      logger: quietLogger,
      limits: { perHost: 4, perPrincipal: 2 },
    });
    const first = opened(relays, "h", "p1");
    opened(relays, "h", "p1");
    expect(opened(relays, "h", "p1").socket.closed).toEqual({
      code: 1008,
      reason: "relay_limit",
    });
    expect(opened(relays, "other", "p1").socket.closed?.reason).toBe(
      "relay_limit",
    );
    expect(opened(relays, "h", null).socket.closed).toBeNull();
    expect(opened(relays, "h", null).socket.closed).toBeNull();
    expect(opened(relays, "h", "p2").socket.closed?.reason).toBe("relay_limit");
    expect(opened(relays, "other", null).socket.closed).toBeNull();
    first.events.onClose();
    expect(opened(relays, "h", "p2").socket.closed).toBeNull();
  });

  it("refuses a relay to a machine that is offline", () => {
    const { hub } = fakeHub();
    const relays = new HostPortRelays({ hub, logger: quietLogger });
    expect(opened(relays, "offline", null).socket.closed).toEqual({
      code: 1008,
      reason: "host_offline",
    });
    expect(relays.count()).toBe(0);
  });

  it("registers nothing until the client socket opens", () => {
    const { hub, messages } = fakeHub();
    const relays = new HostPortRelays({ hub, logger: quietLogger });
    for (let index = 0; index < 100; index += 1)
      relays.client({ hostId: "h", port: 1, principal: "p" });
    expect(relays.count()).toBe(0);
    expect(messages).toEqual([]);
    expect(opened(relays, "h", "p").socket.closed).toBeNull();
    expect(relays.count()).toBe(1);
  });

  it("gives up when the machine never dials back, and when a token is too old", async () => {
    const { hub, messages } = fakeHub();
    let now = 0;
    const relays = new HostPortRelays({
      hub,
      logger: quietLogger,
      now: () => now,
      limits: { connectTimeoutMs: 20, tokenTtlMs: 10 },
    });
    const events = relays.client({ hostId: "h", port: 1, principal: null });
    const client = new FakeSocket();
    events.onOpen(client);
    const connect = messages[0]!.message;
    now = 50;
    const late = new FakeSocket();
    relays.attachDaemon({
      relayId: connect.relayId,
      hostId: "h",
      token: connect.token,
      socket: late,
    });
    expect(late.closed?.code).toBe(1011);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.closed).toEqual({ code: 1011, reason: "timeout" });
    expect(relays.count()).toBe(0);
  });

  it("holds early client bytes up to a limit and then closes", () => {
    const { hub } = fakeHub();
    const relays = new HostPortRelays({
      hub,
      logger: quietLogger,
      limits: { pendingClientBytes: 10 },
    });
    const events = relays.client({ hostId: "h", port: 1, principal: null });
    const client = new FakeSocket();
    events.onOpen(client);
    events.onMessage(new ArrayBuffer(8));
    expect(client.closed).toBeNull();
    events.onMessage(new ArrayBuffer(8));
    expect(client.closed).toEqual({ code: 1009, reason: "limit" });
  });

  it("pauses the reader while the other side holds more than the high-water mark", async () => {
    const { hub, messages } = fakeHub();
    const relays = new HostPortRelays({
      hub,
      logger: quietLogger,
      limits: { highWaterBytes: 100, lowWaterBytes: 20, drainPollMs: 5 },
    });
    const events = relays.client({ hostId: "h", port: 1, principal: null });
    const client = new FakeSocket();
    events.onOpen(client);
    const connect = messages[0]!.message;
    const daemon = new FakeSocket();
    const attached = relays.attachDaemon({
      relayId: connect.relayId,
      hostId: "h",
      token: connect.token,
      socket: daemon,
    });
    client.bufferedAmount = 500;
    attached.onMessage(new ArrayBuffer(10));
    expect(daemon.pauses).toBe(1);
    expect(daemon.resumes).toBe(0);
    client.bufferedAmount = 10;
    await expect.poll(() => daemon.resumes).toBe(1);
  });

  it("closes a relay that carries no bytes for the idle time", async () => {
    const { hub, messages } = fakeHub();
    const relays = new HostPortRelays({
      hub,
      logger: quietLogger,
      limits: { idleTimeoutMs: 20 },
    });
    const events = relays.client({ hostId: "h", port: 1, principal: null });
    const client = new FakeSocket();
    events.onOpen(client);
    const connect = messages[0]!.message;
    relays.attachDaemon({
      relayId: connect.relayId,
      hostId: "h",
      token: connect.token,
      socket: new FakeSocket(),
    });
    await expect
      .poll(() => client.closed)
      .toEqual({
        code: 1000,
        reason: "idle",
      });
  });

  it("gives each relay its own unguessable id and token", () => {
    const { hub, messages } = fakeHub();
    const relays = new HostPortRelays({ hub, logger: quietLogger });
    for (let index = 0; index < 20; index += 1)
      relays
        .client({ hostId: "h", port: 1, principal: null })
        .onOpen(new FakeSocket());
    expect(new Set(messages.map((entry) => entry.message.token)).size).toBe(20);
    expect(new Set(messages.map((entry) => entry.message.relayId)).size).toBe(
      20,
    );
    expect(messages[0]!.message.token.length).toBeGreaterThanOrEqual(43);
  });
});
