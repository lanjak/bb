import { hostPortRelayPath } from "@bb/server-contract";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_PORT_FORWARDS_CHANGED_CHANNEL,
  HOST_PORT_FORWARDS_ENSURE_CHANNEL,
  HOST_PORT_FORWARDS_LIST_CHANNEL,
} from "../src/host-port-forward-channels.js";
import { registerHostPortForwardIpc } from "../src/host-port-forwards-ipc.js";
import {
  HostPortForwardManager,
  HostPortRequestError,
  validateRelayUrl,
} from "../src/host-port-forwards.js";

const ORIGIN = "http://127.0.0.1:38886";

function request(
  overrides: Partial<{
    hostId: string;
    port: number;
    relayUrl: string;
    preferredLocalPort: number;
  }> = {},
) {
  const hostId = overrides.hostId ?? "host_remote";
  const port = overrides.port ?? 5173;
  return {
    hostId,
    port,
    relayUrl:
      overrides.relayUrl ??
      `ws://127.0.0.1:38886${hostPortRelayPath(hostId, port)}`,
    ...(overrides.preferredLocalPort === undefined
      ? {}
      : { preferredLocalPort: overrides.preferredLocalPort }),
  };
}

function manager() {
  const forwards: Array<{
    options: Parameters<
      NonNullable<
        ConstructorParameters<typeof HostPortForwardManager>[0]["forward"]
      >
    >[0];
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const changes: number[] = [];
  const instance = new HostPortForwardManager({
    readCookieHeader: async (origin) =>
      origin === "https://bb.example.com" ? "session=abc" : null,
    onChange: (list) => changes.push(list.length),
    forward: async (options) => {
      const close = vi.fn(async () => undefined);
      forwards.push({ options, close });
      return {
        localPort: options.localPort ?? 54321,
        localHost: "127.0.0.1",
        connections: () => 0,
        close,
      };
    },
  });
  return { instance, forwards, changes };
}

describe("validateRelayUrl", () => {
  it("accepts a relay on the origin of the window that asks", () => {
    expect(
      validateRelayUrl({ request: request(), senderOrigin: ORIGIN }),
    ).toEqual({ serverOrigin: ORIGIN });
    expect(
      validateRelayUrl({
        request: request({
          relayUrl: `wss://bb.example.com${hostPortRelayPath("host_remote", 5173)}`,
        }),
        senderOrigin: "https://bb.example.com",
      }).serverOrigin,
    ).toBe("https://bb.example.com");
  });

  it("refuses a relay through another server, another path, a query, or not a websocket", () => {
    for (const bad of [
      request({
        relayUrl: `ws://evil.example${hostPortRelayPath("host_remote", 5173)}`,
      }),
      request({
        relayUrl: `ws://127.0.0.1:38886${hostPortRelayPath("host_other", 5173)}`,
      }),
      request({
        relayUrl: `ws://127.0.0.1:38886${hostPortRelayPath("host_remote", 22)}`,
      }),
      request({
        relayUrl: `ws://127.0.0.1:38886${hostPortRelayPath("host_remote", 5173)}?x=1`,
      }),
      request({
        relayUrl: `http://127.0.0.1:38886${hostPortRelayPath("host_remote", 5173)}`,
      }),
      request({ relayUrl: "not a url" }),
    ])
      expect(
        () => validateRelayUrl({ request: bad, senderOrigin: ORIGIN }),
        bad.relayUrl,
      ).toThrow(HostPortRequestError);
  });
});

describe("HostPortForwardManager", () => {
  it("starts one forward per machine port, on the preferred local port, and reuses it", async () => {
    const { instance, forwards, changes } = manager();
    const first = await instance.ensure(
      request({ preferredLocalPort: 5173 }),
      ORIGIN,
    );
    const again = await instance.ensure(
      request({ preferredLocalPort: 5173 }),
      ORIGIN,
    );
    expect(first).toEqual({
      hostId: "host_remote",
      port: 5173,
      localPort: 5173,
      connections: 0,
      serverOrigin: ORIGIN,
    });
    expect(again).toEqual(first);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.options.localPort).toBe(5173);
    expect(changes).toEqual([1]);
    await instance.ensure(request({ port: 5432 }), ORIGIN);
    expect(instance.list().map((entry) => entry.port)).toEqual([5173, 5432]);
  });

  it("sends the server's session cookies with the relay", async () => {
    const { instance, forwards } = manager();
    await instance.ensure(
      request({
        relayUrl: `wss://bb.example.com${hostPortRelayPath("host_remote", 5173)}`,
      }),
      "https://bb.example.com",
    );
    expect(forwards[0]!.options.headers).toEqual({ cookie: "session=abc" });
    await instance.ensure(request({ port: 1 }), ORIGIN);
    expect(forwards[1]!.options.headers).toBeUndefined();
  });

  it("stops one forward, only for the window that started it, and all of them on quit", async () => {
    const { instance, forwards, changes } = manager();
    await instance.ensure(request(), ORIGIN);
    await instance.ensure(request({ port: 5432 }), ORIGIN);
    await instance.stop({
      hostId: "host_remote",
      port: 5173,
      senderOrigin: "https://other.example",
    });
    expect(forwards[0]!.close).not.toHaveBeenCalled();
    await instance.stop({
      hostId: "host_remote",
      port: 5173,
      senderOrigin: ORIGIN,
    });
    expect(forwards[0]!.close).toHaveBeenCalledOnce();
    expect(instance.list().map((entry) => entry.port)).toEqual([5432]);
    await instance.stopAll();
    expect(forwards[1]!.close).toHaveBeenCalledOnce();
    expect(instance.list()).toEqual([]);
    expect(changes.at(-1)).toBe(0);
  });

  it("refuses a request that does not match its window", async () => {
    const { instance, forwards } = manager();
    await expect(
      instance.ensure(request(), "http://localhost:3999"),
    ).rejects.toThrow(HostPortRequestError);
    expect(forwards).toEqual([]);
  });

  function slowManager() {
    const opened: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const releases: Array<(fail: boolean) => void> = [];
    const instance = new HostPortForwardManager({
      readCookieHeader: async () => null,
      onChange: () => undefined,
      forward: (options) =>
        new Promise((resolve, reject) => {
          releases.push((fail) => {
            if (fail) {
              reject(new Error("no port"));
              return;
            }
            const close = vi.fn(async () => undefined);
            opened.push({ close });
            resolve({
              localPort: options.localPort ?? 54321,
              localHost: "127.0.0.1",
              connections: () => 0,
              close,
            });
          });
        }),
    });
    return { instance, opened, releases };
  }

  it("starts one forward when the same port is asked for twice at once", async () => {
    const { instance, opened, releases } = slowManager();
    const first = instance.ensure(request(), ORIGIN);
    const second = instance.ensure(request(), ORIGIN);
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releases).toHaveLength(1);
    releases[0]!(false);
    await expect(first).resolves.toEqual(await second);
    expect(instance.list()).toHaveLength(1);
    await instance.stopAll();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.close).toHaveBeenCalledOnce();
  });

  it("tries again after a forward that failed to start", async () => {
    const { instance, releases } = slowManager();
    const failed = instance.ensure(request(), ORIGIN);
    await expect.poll(() => releases.length).toBe(1);
    releases[0]!(true);
    await expect(failed).rejects.toThrow("no port");
    const retried = instance.ensure(request(), ORIGIN);
    await expect.poll(() => releases.length).toBe(2);
    releases[1]!(false);
    await expect(retried).resolves.toMatchObject({ port: 5173 });
  });

  it("closes a forward that finishes starting after every forward was stopped", async () => {
    const { instance, opened, releases } = slowManager();
    const pending = instance.ensure(request(), ORIGIN);
    await expect.poll(() => releases.length).toBe(1);
    await instance.stopAll();
    releases[0]!(false);
    await expect(pending).rejects.toThrow(HostPortRequestError);
    expect(opened[0]!.close).toHaveBeenCalledOnce();
    expect(instance.list()).toEqual([]);
  });

  it("asks for another local port when the preferred one is busy", async () => {
    const { instance, forwards } = manager();
    await instance.ensure(request({ preferredLocalPort: 5173 }), ORIGIN);
    expect(forwards[0]!.options).toMatchObject({
      localPort: 5173,
      fallbackWhenBusy: true,
    });
  });

  it("shows each window only the forwards of the server it shows", async () => {
    const other = "https://bb.example.com";
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, payload?: unknown) => unknown
    >();
    const sent = new Map<string, unknown[]>();
    const contents = [ORIGIN, other].map((origin) => {
      const frame = { url: `${origin}/threads` };
      return {
        mainFrame: frame,
        getURL: () => frame.url,
        isDestroyed: () => false,
        send: (channel: string, forwards: unknown) => {
          if (channel === HOST_PORT_FORWARDS_CHANGED_CHANNEL)
            sent.set(origin, [...(sent.get(origin) ?? []), forwards]);
        },
      } as unknown as WebContents;
    });
    const event = (index: number) =>
      ({
        sender: contents[index],
        senderFrame: contents[index]!.mainFrame,
      }) as unknown as IpcMainInvokeEvent;
    registerHostPortForwardIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      } as Pick<IpcMain, "handle">,
      isApplicationSender: () => true,
      applicationWebContents: () => contents,
      readCookieHeader: async () => null,
      forward: async (options) => ({
        localPort: options.localPort ?? 54321,
        localHost: "127.0.0.1",
        connections: () => 0,
        close: async () => undefined,
      }),
    });
    await handlers.get(HOST_PORT_FORWARDS_ENSURE_CHANNEL)!(event(0), request());
    expect(sent.get(ORIGIN)!.at(-1)).toHaveLength(1);
    expect(sent.get(other)!.at(-1)).toEqual([]);
    expect(
      await handlers.get(HOST_PORT_FORWARDS_LIST_CHANNEL)!(event(0)),
    ).toHaveLength(1);
    expect(
      await handlers.get(HOST_PORT_FORWARDS_LIST_CHANNEL)!(event(1)),
    ).toEqual([]);
  });
});
