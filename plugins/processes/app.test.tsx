// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevServersDetails,
  forwardCommand,
  portLabel,
  summaryLabel,
} from "./app.js";
import { processesContract, type HostDevServer } from "./contract.js";

const THREAD_ID = "thr_dev";

function server(overrides: Partial<HostDevServer> = {}): HostDevServer {
  return {
    threadId: THREAD_ID,
    rootPid: 140,
    startToken: "tok-140",
    startedAt: 1,
    command: "npm run dev",
    cwd: "/work/app",
    ports: [{ port: 5173, address: "127.0.0.1" }],
    hostId: "host_1",
    hostName: "laptop",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

function renderDetails(
  servers: HostDevServer[],
  options: Parameters<typeof renderSlot>[2] = {},
  share: unknown = { status: "connect-off", reason: "off" },
) {
  return renderSlot(
    { component: DevServersDetails },
    {
      threadId: THREAD_ID,
      projectId: "proj_1",
      environment: null,
      segments: [],
      isExpanded: true,
      onToggle: () => {},
    },
    {
      ...options,
      experimental_rpcContract: processesContract,
      rpc: {
        "servers.list": () => ({
          status: "ok" as const,
          reason: null,
          servers,
        }),
        "servers.open": () => share as never,
        "processes.stop": () => ({ outcome: "stopped" as const }),
      },
    },
  );
}

describe("servers segment", () => {
  it("summarizes the servers and their first ports", () => {
    expect(summaryLabel([server()])).toBe("1 server · :5173");
    expect(
      summaryLabel([
        server({
          ports: [
            { port: 3000, address: "::1" },
            { port: 3001, address: "::1" },
          ],
        }),
        server({
          rootPid: 200,
          ports: [
            { port: 8080, address: "0.0.0.0" },
            { port: 9000, address: "0.0.0.0" },
          ],
        }),
      ]),
    ).toBe("2 servers · :3000 :3001 :8080 +1");
  });

  it("opens a port through the shared opener and stops the server through the plugin", async () => {
    const slot = renderDetails([server()], {
      openHostPort: async () => ({
        via: "local" as const,
        url: "http://localhost:5173/",
      }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Open :5173 on laptop" }),
    );
    await expect
      .poll(() => slot.inspection.navigateCalls)
      .toMatchObject([
        {
          method: "experimental_openHostPort",
          options: { hostId: "host_1", port: 5173, target: "bb-browser" },
        },
      ]);
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "servers.open"),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop the server on :5173" }),
    );
    await expect
      .poll(() =>
        slot.inspection.rpcCalls.find(
          (call) => call.method === "processes.stop",
        ),
      )
      .toMatchObject({
        input: { threadId: THREAD_ID, rootPid: 140, startToken: "tok-140" },
      });
  });

  it("shows where a forwarded port went, and opens the first port in the system browser on request", async () => {
    const slot = renderDetails([server()], {
      openHostPort: async () => ({
        via: "forward" as const,
        localPort: 54321,
        url: `http://localhost:54321/`,
      }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open :5173 on laptop" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Open 5173 -> localhost:54321 on laptop",
      }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open the first port of laptop in the system browser",
      }),
    );
    await expect
      .poll(() => slot.inspection.navigateCalls.at(-1))
      .toMatchObject({
        method: "experimental_openHostPort",
        options: { target: "external" },
      });
  });

  it("shares the port through bb Connect when this device cannot reach it, and opens the share", async () => {
    const slot = renderDetails(
      [server()],
      {
        openHostPort: async () => ({
          via: "unreachable" as const,
          reason: "no route",
        }),
      },
      { status: "ok", url: "https://handle--5173.getbb.app/" },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open :5173 on laptop" }),
    );
    await expect
      .poll(() =>
        slot.inspection.rpcCalls.find((call) => call.method === "servers.open"),
      )
      .toMatchObject({
        input: { threadId: THREAD_ID, hostId: "host_1", port: 5173 },
      });
    await expect
      .poll(() => slot.inspection.navigateCalls.at(-1))
      .toEqual({ method: "openUrl", url: "https://handle--5173.getbb.app/" });
    const link = await screen.findByRole("link", {
      name: "Open the bb Connect share of :5173",
    });
    expect(link.getAttribute("href")).toBe("https://handle--5173.getbb.app/");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("explains how to forward when bb Connect is off, without opening anything", async () => {
    const slot = renderDetails(
      [server({ hostName: "build-box" })],
      {
        openHostPort: async () => ({
          via: "unreachable" as const,
          reason: "no route",
        }),
      },
      { status: "connect-off", reason: "Open this from the desktop app." },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open :5173 on build-box" }),
    );
    expect(
      await screen.findByText("Open this from the desktop app."),
    ).not.toBeNull();
    expect(
      slot.inspection.navigateCalls.some((call) => call.method === "openUrl"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Copy command" })).not.toBeNull();
  });

  it("labels a port with its mapping and builds the manual forward command", () => {
    expect(portLabel(5173, undefined)).toBe(":5173");
    expect(portLabel(5173, 5173)).toBe(":5173");
    expect(portLabel(5173, 54321)).toBe("5173 -> localhost:54321");
    expect(forwardCommand(server({ hostName: "My Laptop" }), 5432)).toBe(
      "bb machine forward 5432 --machine host_1",
    );
  });
});
