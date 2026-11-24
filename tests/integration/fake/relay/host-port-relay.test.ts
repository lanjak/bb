import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createNodeBbSdk, experimental_forwardHostPort } from "@bb/sdk";
import type { HostPortForward, HostPortForwardError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { waitForHostConnected } from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import { DEFAULT_TIMEOUT_MS } from "../smoke/shared.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function listen(
  server: net.Server | http.Server,
  host = "127.0.0.1",
): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () =>
      resolve((server.address() as net.AddressInfo).port),
    );
  });
}

function close(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (server instanceof http.Server) server.closeAllConnections();
  });
}

function echoServer(): net.Server {
  return net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
    socket.on("error", () => undefined);
  });
}

function roundTrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.write(payload, () => socket.end());
  });
}

function upgradeStatus(
  serverUrl: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, serverUrl), {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.once("error", reject);
    request.end();
  });
}

function refusalReason(serverUrl: string, path: string): Promise<string> {
  const url = new URL(path, serverUrl);
  url.protocol = "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onclose = (event) => resolve(event.reason);
    socket.onerror = () => reject(new Error("WebSocket failed"));
  });
}

function upgradeWithoutKey(serverUrl: string, path: string): Promise<string> {
  const url = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-bb-gate-auth: session\r\n\r\n`,
      ),
    );
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response.split("\r\n")[0] ?? ""));
  });
}

function runForwardCommand(serverUrl: string, args: string[]) {
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      "apps/cli/src/index.ts",
      "machine",
      "forward",
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, BB_SERVER_URL: serverUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  return { child, output, exited };
}

function machineCredentialProxy(serverUrl: string): http.Server {
  return http.createServer((request, response) => {
    const upstream = http.request(
      new URL(request.url ?? "/", serverUrl),
      {
        method: request.method,
        headers: { ...request.headers, "x-bb-gate-auth": "machine" },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
}

async function withForward<T>(
  serverUrl: string,
  hostId: string,
  port: number,
  run: (forward: HostPortForward, errors: HostPortForwardError[]) => Promise<T>,
  localPort = 0,
): Promise<T> {
  const errors: HostPortForwardError[] = [];
  const forward = await experimental_forwardHostPort({
    sdk: createNodeBbSdk({ baseUrl: serverUrl }),
    hostId,
    port,
    localPort,
    onError: (error) => errors.push(error),
  });
  try {
    return await run(forward, errors);
  } finally {
    await forward.close();
  }
}

describe.sequential("host port relay through a real server and daemon", () => {
  it("carries 5 MB of raw TCP each way to a loopback port on the machine", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const echo = echoServer();
      const port = await listen(echo);
      try {
        await withForward(
          harness.serverUrl,
          harness.hostId,
          port,
          async (forward) => {
            expect(forward.localPort).not.toBe(port);
            const payload = Buffer.alloc(5 * 1024 * 1024, "bb relay ");
            const received = await roundTrip(forward.localPort, payload);
            expect(received.length).toBe(payload.length);
            expect(received.equals(payload)).toBe(true);
          },
        );
      } finally {
        await close(echo);
      }
    }));

  it("carries HTTP and a WebSocket to a dev server on the machine", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const http1 = http.createServer((_request, response) => {
        response.end("directory listing");
      });
      const upgraded = new Set<Duplex>();
      http1.on("upgrade", (request, socket) => {
        upgraded.add(socket);
        const accept = createHash("sha1")
          .update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`)
          .digest("base64");
        const message = Buffer.from("hmr update");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(
          Buffer.concat([Buffer.from([0x81, message.length]), message]),
        );
        socket.on("error", () => undefined);
      });
      const port = await listen(http1);
      try {
        await withForward(
          harness.serverUrl,
          harness.hostId,
          port,
          async (forward) => {
            const response = await fetch(
              `http://127.0.0.1:${forward.localPort}/`,
            );
            expect(await response.text()).toBe("directory listing");
            const hmr = await new Promise<string>((resolve, reject) => {
              const socket = new WebSocket(
                `ws://127.0.0.1:${forward.localPort}/hmr`,
              );
              socket.onmessage = (event) => {
                resolve(String(event.data));
                socket.close();
              };
              socket.onerror = () => reject(new Error("WebSocket failed"));
              setTimeout(
                () => reject(new Error("WebSocket timed out")),
                10_000,
              );
            });
            expect(hmr).toBe("hmr update");
          },
        );
      } finally {
        for (const socket of upgraded) socket.destroy();
        await close(http1);
      }
    }));

  it("sends one connection to the machine's loopback and fails for a port nothing listens on", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const probe = net.createServer();
      const closedPort = await listen(probe);
      await close(probe);
      await withForward(
        harness.serverUrl,
        harness.hostId,
        closedPort,
        async (forward, errors) => {
          await roundTrip(forward.localPort, Buffer.from("hello"));
          await expect
            .poll(() => errors.map((error) => error.code), { timeout: 15_000 })
            .toEqual(["refused"]);
        },
      );
    }));

  it("does not reach a listener that is bound only to the machine's LAN address", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal);
      if (lan === undefined) return;
      const echo = echoServer();
      const port = await listen(echo, lan.address);
      try {
        await withForward(
          harness.serverUrl,
          harness.hostId,
          port,
          async (forward, errors) => {
            await roundTrip(forward.localPort, Buffer.from("hello"));
            await expect
              .poll(() => errors.map((error) => error.code), {
                timeout: 15_000,
              })
              .toEqual(["refused"]);
          },
        );
      } finally {
        await close(echo);
      }
    }));

  it("refuses a relay request from a web page on another origin, and for a machine that does not exist", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const path = `/ws/host-ports/${harness.hostId}/5432`;
      expect(
        await upgradeStatus(harness.serverUrl, path, {
          Origin: "https://evil.example",
        }),
      ).toBe(403);
      expect(
        await upgradeStatus(harness.serverUrl, path, {
          Origin: "http://localhost:3999",
        }),
      ).toBe(403);
      expect(await upgradeStatus(harness.serverUrl, path, {})).toBe(101);
      await expect(
        refusalReason(harness.serverUrl, "/ws/host-ports/host_nope/5432"),
      ).resolves.toBe("host_not_found");
      await expect(
        refusalReason(
          harness.serverUrl,
          `/ws/host-ports/${harness.hostId}/70000`,
        ),
      ).resolves.toBe("invalid_port");
    }));

  it("forwards after 70 upgrades that failed", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const echo = echoServer();
      const port = await listen(echo);
      try {
        for (let index = 0; index < 70; index += 1)
          await expect(
            upgradeWithoutKey(
              harness.serverUrl,
              `/ws/host-ports/${harness.hostId}/${port}`,
            ),
          ).resolves.toContain("400");
        await withForward(
          harness.serverUrl,
          harness.hostId,
          port,
          async (forward, errors) => {
            const received = await roundTrip(
              forward.localPort,
              Buffer.from("still open"),
            );
            expect(received.toString()).toBe("still open");
            expect(errors).toEqual([]);
          },
        );
      } finally {
        await close(echo);
      }
    }));

  it(
    "listens on the machine's port number for bb machine forward <port>, and fails when it is busy",
    () =>
      withHarness(async (harness) => {
        await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
        const free = net.createServer();
        const port = await listen(free);
        await close(free);
        const forwarding = runForwardCommand(harness.serverUrl, [
          String(port),
          "--machine",
          harness.hostId,
        ]);
        try {
          await expect
            .poll(() => forwarding.output.stdout, { timeout: 60_000 })
            .toContain(`Forwarding localhost:${port} -> `);
          forwarding.child.kill("SIGINT");
          await expect(forwarding.exited).resolves.toBe(0);
        } finally {
          forwarding.child.kill("SIGKILL");
        }
        const taken = echoServer();
        const busyPort = await listen(taken);
        try {
          const refused = runForwardCommand(harness.serverUrl, [
            String(busyPort),
            "--machine",
            harness.hostId,
          ]);
          await expect(refused.exited).resolves.toBe(1);
          expect(refused.output.stderr).toContain(
            `Local port ${busyPort} is already in use`,
          );
        } finally {
          await close(taken);
        }
      }),
    120_000,
  );

  it(
    "exits before listening when the CLI's connection is a machine credential",
    () =>
      withHarness(async (harness) => {
        await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
        const proxy = machineCredentialProxy(harness.serverUrl);
        const proxyPort = await listen(proxy);
        try {
          const refused = runForwardCommand(`http://127.0.0.1:${proxyPort}`, [
            "5432:0",
            "--machine",
            harness.hostId,
          ]);
          await expect(refused.exited).resolves.toBe(1);
          expect(refused.output.stderr).toContain("machine credential");
          expect(refused.output.stdout).not.toContain("Forwarding");
        } finally {
          await close(proxy);
        }
      }),
    120_000,
  );

  it(
    "forwards from bb machine forward and stops with Ctrl-C",
    () =>
      withHarness(async (harness) => {
        await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
        const echo = echoServer();
        const port = await listen(echo);
        const free = net.createServer();
        const localPort = await listen(free);
        await close(free);
        const child = spawn(
          process.execPath,
          [
            "--conditions=source",
            "--import",
            "tsx",
            "apps/cli/src/index.ts",
            "machine",
            "forward",
            `${port}:${localPort}`,
            "--machine",
            harness.hostId,
          ],
          {
            cwd: REPO_ROOT,
            env: { ...process.env, BB_SERVER_URL: harness.serverUrl },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        const exited = new Promise<number | null>((resolve) =>
          child.once("close", resolve),
        );
        try {
          await expect
            .poll(() => stdout, { timeout: 60_000 })
            .toContain(`Forwarding localhost:${localPort} ->`);
          expect(
            (
              await roundTrip(localPort, Buffer.from("through the cli"))
            ).toString(),
          ).toBe("through the cli");
          child.kill("SIGINT");
          await expect(exited).resolves.toBe(0);
        } finally {
          child.kill("SIGKILL");
          await close(echo);
        }
        expect(stderr).toBe("");
      }),
    120_000,
  );

  it("exits 1 and names the problem when the machine does not exist", () =>
    withHarness(async (harness) => {
      await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      const child = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          "apps/cli/src/index.ts",
          "machine",
          "forward",
          "5432",
          "--machine",
          "no-such-machine",
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, BB_SERVER_URL: harness.serverUrl },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve) =>
        child.once("close", resolve),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("no-such-machine");
    }));
});
