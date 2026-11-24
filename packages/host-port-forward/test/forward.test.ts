import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  forwardHostPort,
  HostPortBusyError,
  type HostPortForward,
  type HostPortForwardError,
} from "../src/index.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listenTcp(
  handler: (socket: net.Socket) => void,
  host = "127.0.0.1",
): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer(handler);
    server.listen(0, host, () => {
      cleanups.push(
        () => new Promise<void>((done) => server.close(() => done())),
      );
      resolve({
        port: (server.address() as net.AddressInfo).port,
        server,
      });
    });
  });
}

function echo(socket: net.Socket): void {
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("end", () => socket.end());
  socket.on("error", () => undefined);
}

interface FakeRelay {
  url: string;
  sockets: Set<WebSocket>;
}

async function fakeRelay(
  target: number,
  options: {
    reject?: { status: number };
    closeWith?: { code: number; reason: string };
    sendOnOpen?: Buffer;
  } = {},
): Promise<FakeRelay> {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (options.reject !== undefined) {
      socket.end(
        `HTTP/1.1 ${options.reject.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      if (options.closeWith !== undefined) {
        ws.close(options.closeWith.code, options.closeWith.reason);
        return;
      }
      if (options.sendOnOpen !== undefined) {
        ws.send(options.sendOnOpen);
        return;
      }
      const tcp = net.connect(target, "127.0.0.1");
      tcp.pause();
      tcp.once("connect", () => tcp.resume());
      tcp.on("data", (chunk) => ws.send(chunk));
      tcp.on("end", () => ws.send("fin"));
      tcp.on("close", () => ws.close(1000));
      tcp.on("error", () => ws.close(1011, "refused"));
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          if (data.toString() === "fin") tcp.end();
          return;
        }
        tcp.write(data);
      });
      ws.on("close", () => tcp.destroy());
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  cleanups.push(async () => {
    for (const ws of sockets) ws.terminate();
    wss.close();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/ws/host-ports/h/1`,
    sockets,
  };
}

async function startForward(
  relay: FakeRelay,
  extra: {
    localPort?: number;
    fallbackWhenBusy?: boolean;
    bindHost?: "127.0.0.1" | "::1";
    onError?: (error: HostPortForwardError) => void;
  } = {},
): Promise<HostPortForward> {
  const forward = await forwardHostPort({ relayUrl: relay.url, ...extra });
  cleanups.push(() => forward.close());
  return forward;
}

function holdPort(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ port, host, ipv6Only: host.includes(":") }, () => {
      cleanups.push(
        () => new Promise<void>((done) => server.close(() => done())),
      );
      resolve();
    });
  });
}

async function unusedPort(): Promise<number> {
  const free = await listenTcp(() => undefined);
  await new Promise<void>((done) => free.server.close(() => done()));
  return free.port;
}

function roundTrip(
  port: number,
  payload: Buffer,
  host = "127.0.0.1",
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, host);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.write(payload, () => socket.end());
  });
}

describe("forwardHostPort", () => {
  it("carries 5 MB each way and ends when the remote ends", async () => {
    const target = await listenTcp(echo);
    const forward = await startForward(await fakeRelay(target.port));
    const payload = Buffer.alloc(5 * 1024 * 1024, "bb-relay ");
    const received = await roundTrip(forward.localPort, payload);
    expect(received.length).toBe(payload.length);
    expect(received.equals(payload)).toBe(true);
  }, 30_000);

  it("keeps the remote's reply after the local side half-closes", async () => {
    const target = await listenTcp((socket) => {
      const parts: Buffer[] = [];
      socket.on("data", (chunk) => parts.push(chunk));
      socket.on("end", () => {
        socket.end(`got ${Buffer.concat(parts).toString()}`);
      });
    });
    const forward = await startForward(await fakeRelay(target.port));
    const received = await roundTrip(forward.localPort, Buffer.from("hello"));
    expect(received.toString()).toBe("got hello");
  });

  it("listens on the requested local port, and fails when it is busy", async () => {
    const target = await listenTcp(echo);
    const relay = await fakeRelay(target.port);
    const port = await unusedPort();
    const first = await startForward(relay, { localPort: port });
    expect(first.localPort).toBe(port);
    await expect(startForward(relay, { localPort: port })).rejects.toThrow(
      HostPortBusyError,
    );
  });

  it("takes a free port instead of a busy one only when asked to", async () => {
    const target = await listenTcp(echo);
    const relay = await fakeRelay(target.port);
    const first = await startForward(relay);
    const second = await startForward(relay, {
      localPort: first.localPort,
      fallbackWhenBusy: true,
    });
    expect(second.localPort).not.toBe(first.localPort);
  });

  it.each(["::1", "127.0.0.1", "0.0.0.0", "::"])(
    "counts a port as busy when another program holds it on %s",
    async (holder) => {
      const target = await listenTcp(echo);
      const relay = await fakeRelay(target.port);
      const port = await unusedPort();
      await holdPort(port, holder);
      await expect(startForward(relay, { localPort: port })).rejects.toThrow(
        HostPortBusyError,
      );
      const moved = await startForward(relay, {
        localPort: port,
        fallbackWhenBusy: true,
      });
      expect(moved.localPort).not.toBe(port);
      for (const host of ["127.0.0.1", "::1"])
        await expect(
          roundTrip(moved.localPort, Buffer.from(host), host),
        ).resolves.toEqual(Buffer.from(host));
    },
  );

  it("reports the address it was told to bind, and refuses it when the other loopback is held", async () => {
    const target = await listenTcp(echo);
    const relay = await fakeRelay(target.port);
    const forward = await startForward(relay, { bindHost: "::1" });
    expect(forward.localHost).toBe("::1");
    await expect(
      roundTrip(forward.localPort, Buffer.from("six"), "::1"),
    ).resolves.toEqual(Buffer.from("six"));
    const port = await unusedPort();
    await holdPort(port, "127.0.0.1");
    await expect(
      startForward(relay, { localPort: port, bindHost: "::1" }),
    ).rejects.toThrow(HostPortBusyError);
  });

  it("listens on loopback only", async () => {
    const target = await listenTcp(echo);
    const forward = await startForward(await fakeRelay(target.port));
    expect(forward.localHost).toBe("127.0.0.1");
    const viaLoopback = await roundTrip(forward.localPort, Buffer.from("x"));
    expect(viaLoopback.toString()).toBe("x");
    const lan = Object.values((await import("node:os")).networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal);
    if (lan !== undefined) {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = net.connect(forward.localPort, lan.address);
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        }),
      ).rejects.toThrow();
    }
  });

  it("reports why the server refused a relay it had upgraded", async () => {
    for (const [reason, fatal] of [
      ["host_offline", false],
      ["relay_limit", false],
      ["host_not_found", true],
      ["machine_credential", true],
    ] as const) {
      const errors: HostPortForwardError[] = [];
      const forward = await startForward(
        await fakeRelay(0, { closeWith: { code: 1008, reason } }),
        { onError: (error) => errors.push(error) },
      );
      await roundTrip(forward.localPort, Buffer.from("x"));
      await expect.poll(() => errors.length).toBe(1);
      expect(errors[0], reason).toMatchObject({ code: reason, fatal });
    }
  });

  it("does not guess a relay error from the HTTP status of a refused upgrade", async () => {
    for (const [status, fatal] of [
      [200, true],
      [403, true],
      [404, true],
      [409, false],
      [502, false],
    ] as const) {
      const errors: HostPortForwardError[] = [];
      const forward = await startForward(
        await fakeRelay(0, { reject: { status } }),
        { onError: (error) => errors.push(error) },
      );
      await roundTrip(forward.localPort, Buffer.from("x"));
      await expect.poll(() => errors.length).toBe(1);
      expect(errors[0]!.code, `${status}`).toBe("relay_unreachable");
      expect(errors[0]!.message).toContain(`HTTP ${status}`);
      expect(errors[0]!.fatal, `${status}`).toBe(fatal);
    }
  });

  it("drops a connection when the relay sends a frame over 64 KiB", async () => {
    const relay = await fakeRelay(0, {
      sendOnOpen: Buffer.alloc(64 * 1024 + 1),
    });
    const forward = await startForward(relay);
    await expect(
      roundTrip(forward.localPort, Buffer.from("x")),
    ).resolves.toEqual(Buffer.alloc(0));
  });

  it("reports a refused port and drops the local connection", async () => {
    const errors: HostPortForwardError[] = [];
    const forward = await startForward(
      await fakeRelay(0, { closeWith: { code: 1011, reason: "refused" } }),
      { onError: (error) => errors.push(error) },
    );
    await roundTrip(forward.localPort, Buffer.from("x"));
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ code: "refused", fatal: false });
  });

  it("closes every open connection when it stops", async () => {
    const target = await listenTcp(echo);
    const forward = await startForward(await fakeRelay(target.port));
    const socket = net.connect(forward.localPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await expect.poll(() => forward.connections()).toBe(1);
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    await forward.close();
    await closed;
    expect(forward.connections()).toBe(0);
  });
});
