import http from "node:http";
import net from "node:net";
import {
  HOST_PORT_RELAY_TOKEN_HEADER,
  type HostPortConnectFailedMessage,
  type HostPortConnectMessage,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostDaemonLogger } from "../logger.js";
import { HostPortRelayManager } from "./relay.js";

const logger: HostDaemonLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface FakeServer {
  url: string;
  dialBacks: Array<{
    path: string;
    headers: http.IncomingHttpHeaders;
    socket: WebSocket;
  }>;
  next(): Promise<WebSocket>;
}

async function fakeServer(): Promise<FakeServer> {
  const dialBacks: FakeServer["dialBacks"] = [];
  const waiting: Array<(socket: WebSocket) => void> = [];
  let consumed = 0;
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      dialBacks.push({
        path: request.url ?? "",
        headers: request.headers,
        socket: ws,
      });
      waiting.shift()?.(ws);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  cleanups.push(async () => {
    for (const { socket } of dialBacks) socket.terminate();
    wss.close();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    dialBacks,
    next: () =>
      new Promise((resolve) => {
        const ready = dialBacks[consumed];
        consumed += 1;
        if (ready !== undefined) resolve(ready.socket);
        else waiting.push(resolve);
      }),
  };
}

async function tcpServer(
  handler: (socket: net.Socket) => void,
  host = "127.0.0.1",
): Promise<number> {
  const server = net.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return (server.address() as net.AddressInfo).port;
}

function manager(
  serverUrl: string,
  failures: HostPortConnectFailedMessage[] = [],
  options: Partial<ConstructorParameters<typeof HostPortRelayManager>[0]> = {},
): HostPortRelayManager {
  const relays = new HostPortRelayManager({
    serverUrl,
    hostKey: "host-key-secret",
    serverHeaders: { "x-bb-connect-machine": "machine-credential" },
    logger,
    sendToServer: (message) => failures.push(message),
    ...options,
  });
  cleanups.push(() => relays.closeAll());
  return relays;
}

function message(
  port: number,
  id = "relay-0123456789abcdef",
): HostPortConnectMessage {
  return {
    type: "host-port.connect",
    relayId: id,
    port,
    token: "T".repeat(43),
  };
}

function collect(socket: WebSocket): Buffer[] {
  const received: Buffer[] = [];
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) received.push(data);
  });
  return received;
}

describe("HostPortRelayManager", () => {
  it("dials back with the daemon's credentials and the relay token, then carries bytes both ways", async () => {
    const echoPort = await tcpServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("end", () => socket.end());
    });
    const server = await fakeServer();
    const relays = manager(server.url);
    const ready = server.next();
    await relays.connect(message(echoPort));
    const ws = await ready;
    const request = server.dialBacks[0]!;
    expect(request.path).toBe("/internal/host-ports/relay-0123456789abcdef");
    expect(request.headers.authorization).toBe("Bearer host-key-secret");
    expect(request.headers[HOST_PORT_RELAY_TOKEN_HEADER]).toBe("T".repeat(43));
    expect(request.headers["x-bb-connect-machine"]).toBe("machine-credential");

    const received = collect(ws);
    const payload = Buffer.alloc(3 * 1024 * 1024, "relay");
    for (let offset = 0; offset < payload.length; offset += 64 * 1024)
      ws.send(payload.subarray(offset, offset + 64 * 1024));
    await expect
      .poll(() => Buffer.concat(received).length, { timeout: 15_000 })
      .toBe(payload.length);
    expect(Buffer.concat(received).equals(payload)).toBe(true);
    expect(
      Math.max(...received.map((chunk) => chunk.length)),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it("closes the relay when the server sends a frame over 64 KiB, and writes none of it", async () => {
    const written: Buffer[] = [];
    let targetClosed = false;
    const port = await tcpServer((socket) => {
      socket.on("data", (chunk) => written.push(chunk));
      socket.on("close", () => {
        targetClosed = true;
      });
      socket.on("error", () => undefined);
    });
    const server = await fakeServer();
    const relays = manager(server.url);
    const ready = server.next();
    await relays.connect(message(port));
    const ws = await ready;
    ws.send(Buffer.alloc(64 * 1024 + 1));
    await expect.poll(() => targetClosed).toBe(true);
    expect(written).toEqual([]);
    await expect.poll(() => relays.count()).toBe(0);
  });

  it("closes the dial-back when the target closes, and the target when the dial-back closes", async () => {
    let targetSocket: net.Socket | null = null;
    const port = await tcpServer((socket) => {
      targetSocket = socket;
      socket.on("error", () => undefined);
    });
    const server = await fakeServer();
    const relays = manager(server.url);
    const ready = server.next();
    await relays.connect(message(port));
    const ws = await ready;
    await expect.poll(() => relays.count()).toBe(1);
    const closed = new Promise<number>((resolve) =>
      ws.once("close", (code: number) => resolve(code)),
    );
    targetSocket!.destroy();
    await expect(closed).resolves.toBe(1000);
    await expect.poll(() => relays.count()).toBe(0);

    const port2 = await tcpServer((socket) => {
      targetSocket = socket;
      socket.on("error", () => undefined);
    });
    const ready2 = server.next();
    await relays.connect(message(port2, "relay-second-0123456789"));
    const ws2 = await ready2;
    const targetClosed = new Promise<void>((resolve) =>
      targetSocket!.once("close", () => resolve()),
    );
    ws2.close(1000);
    await targetClosed;
  });

  it("passes a half-close in each direction as a text frame", async () => {
    const port = await tcpServer((socket) => {
      const parts: Buffer[] = [];
      socket.on("data", (chunk) => parts.push(chunk));
      socket.on("end", () =>
        socket.end(`reply to ${Buffer.concat(parts).toString()}`),
      );
    });
    const server = await fakeServer();
    const relays = manager(server.url);
    const ready = server.next();
    await relays.connect(message(port));
    const ws = await ready;
    const received = collect(ws);
    const texts: string[] = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) texts.push(data.toString("utf8"));
    });
    ws.send(Buffer.from("question"));
    ws.send("fin");
    await expect.poll(() => texts).toEqual(["fin"]);
    expect(Buffer.concat(received).toString()).toBe("reply to question");
  });

  it("tells the server when nothing listens on the port", async () => {
    const free = await tcpServer(() => undefined);
    const failures: HostPortConnectFailedMessage[] = [];
    const probe = net.createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve()),
    );
    const closedPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    void free;
    const relays = manager("http://127.0.0.1:1", failures);
    await relays.connect(message(closedPort));
    expect(failures).toEqual([
      {
        type: "host-port.connect-failed",
        relayId: "relay-0123456789abcdef",
        code: "refused",
        message: "ECONNREFUSED",
      },
    ]);
    expect(relays.count()).toBe(0);
  });

  it("dials only the machine's own loopback addresses", async () => {
    const dialed: string[] = [];
    const failures: HostPortConnectFailedMessage[] = [];
    const relays = manager("http://127.0.0.1:1", failures, {
      dial: async (port, address) => {
        dialed.push(`${address}:${port}`);
        throw new Error("no");
      },
    });
    await relays.connect(message(5432));
    expect(dialed).toEqual(["127.0.0.1:5432", "::1:5432"]);
    expect(failures[0]).toMatchObject({ code: "error" });
  });

  it("tries ::1 when 127.0.0.1 has no listener", async () => {
    const dialed: string[] = [];
    const target = await tcpServer((socket) =>
      socket.on("error", () => undefined),
    );
    const server = await fakeServer();
    const relays = manager(server.url, [], {
      dial: async (_port, address) => {
        dialed.push(address);
        if (address === "127.0.0.1")
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        const socket = net.connect({ host: "127.0.0.1", port: target });
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        return socket;
      },
    });
    const ready = server.next();
    await relays.connect(message(5432));
    await ready;
    expect(dialed).toEqual(["127.0.0.1", "::1"]);
  });

  it("refuses more relays than its limit", async () => {
    const port = await tcpServer((socket) =>
      socket.on("error", () => undefined),
    );
    const server = await fakeServer();
    const failures: HostPortConnectFailedMessage[] = [];
    const relays = manager(server.url, failures, { limits: { maxRelays: 2 } });
    for (const id of ["relay-aaaaaaaaaaaaaaaa", "relay-bbbbbbbbbbbbbbbb"]) {
      const ready = server.next();
      await relays.connect(message(port, id));
      await ready;
    }
    await relays.connect(message(port, "relay-cccccccccccccccc"));
    expect(failures).toMatchObject([{ code: "limit" }]);
    expect(relays.count()).toBe(2);
  });

  it("drops the local connection when the dial-back cannot open", async () => {
    let targetSocket: net.Socket | null = null;
    const port = await tcpServer((socket) => {
      targetSocket = socket;
      socket.on("error", () => undefined);
    });
    const relays = manager("http://127.0.0.1:1");
    await relays.connect(message(port));
    await expect.poll(() => targetSocket?.destroyed ?? false).toBe(true);
    await expect.poll(() => relays.count()).toBe(0);
  });

  it("closes every relay when the daemon shuts down", async () => {
    const port = await tcpServer((socket) =>
      socket.on("error", () => undefined),
    );
    const server = await fakeServer();
    const relays = manager(server.url);
    const ready = server.next();
    await relays.connect(message(port));
    const ws = await ready;
    const closed = new Promise<void>((resolve) =>
      ws.once("close", () => resolve()),
    );
    relays.closeAll();
    await closed;
  });
});
