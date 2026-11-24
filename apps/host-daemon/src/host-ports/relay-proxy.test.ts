import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const moduleUrl = new URL("./relay.ts", import.meta.url).href;
const envProxySupported =
  process.allowedNodeEnvironmentFlags.has("--use-env-proxy");

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      closers.push(
        () => new Promise<void>((done) => server.close(() => done())),
      );
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

describe.skipIf(!envProxySupported)("HostPortRelayManager proxy", () => {
  it("dials back to the server through the environment proxy", async () => {
    const proxyLog: string[] = [];
    const dialBackHeaders: string[] = [];
    const wss = new WebSocketServer({ noServer: true });
    const target = http.createServer();
    target.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        dialBackHeaders.push(request.url ?? "");
        ws.send(Buffer.from("through the proxy"));
        setTimeout(() => ws.close(1000), 200);
      });
    });
    const targetPort = await listen(target);
    const sockets = new Set<Duplex>();
    closers.push(() => {
      for (const socket of sockets) socket.destroy();
      wss.close();
    });
    const proxy = http.createServer((_request, response) => {
      response.writeHead(502).end();
    });
    proxy.on("upgrade", (request, client, head) => {
      proxyLog.push(`UPGRADE ${new URL(request.url ?? "").host}`);
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        const lines: string[] = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2)
          lines.push(
            `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
          );
        const url = new URL(request.url ?? "");
        upstream.write(
          `GET ${url.pathname}${url.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
        );
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      sockets.add(client);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const echo = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => undefined);
    });
    const echoPort = await listen(echo);

    const script = `
      const { HostPortRelayManager } = await import(${JSON.stringify(moduleUrl)});
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const manager = new HostPortRelayManager({
        serverUrl: "http://relay-only.invalid:${targetPort}",
        hostKey: "key",
        serverHeaders: {},
        logger,
        sendToServer: () => {},
      });
      await manager.connect({
        type: "host-port.connect",
        relayId: "relay-proxy-0123456789",
        port: ${echoPort},
        token: "T".repeat(43),
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      manager.closeAll();
      console.log("done");
    `;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
    };
    for (const key of ["http_proxy", "https_proxy", "no_proxy", "ALL_PROXY"])
      delete env[key];
    delete env.NODE_OPTIONS;
    delete env.VITEST;
    const child = spawn(
      process.execPath,
      [
        "--use-env-proxy",
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(exitCode, stderr).toBe(0);
    expect(proxyLog).toEqual([`UPGRADE relay-only.invalid:${targetPort}`]);
    expect(dialBackHeaders).toEqual([
      "/internal/host-ports/relay-proxy-0123456789",
    ]);
  }, 30_000);
});
