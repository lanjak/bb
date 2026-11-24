// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type {
  BbDesktopHostPortForward,
  BbDesktopHostPortsApi,
} from "@bb/desktop-contract";
import { PortForwardsSettings, describeForward } from "./PortForwardsSettings";

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [{ id: "host_remote", name: "build-box" }] }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const forward: BbDesktopHostPortForward = {
  hostId: "host_remote",
  port: 5173,
  localPort: 54321,
  connections: 2,
  serverOrigin: "http://127.0.0.1:38886",
};

function renderWith(hostPorts: BbDesktopHostPortsApi | undefined) {
  vi.stubGlobal("bbDesktop", hostPorts === undefined ? {} : { hostPorts });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PortForwardsSettings />
    </QueryClientProvider>,
  );
}

it("draws nothing outside the desktop app, or with no forward", async () => {
  const none = renderWith(undefined);
  expect(none.container.textContent).toBe("");
  cleanup();
  const empty = renderWith({
    ensure: vi.fn(),
    stop: vi.fn(),
    list: async () => [],
    onChange: () => () => undefined,
  });
  await Promise.resolve();
  expect(empty.container.textContent).toBe("");
});

it("lists each forward with its machine and mapping, and stops one", async () => {
  const stop = vi.fn(async () => undefined);
  renderWith({
    ensure: vi.fn(),
    stop,
    list: async () => [forward],
    onChange: () => () => undefined,
  });
  expect(await screen.findByText("build-box")).not.toBeNull();
  expect(
    screen.getByText(/5173 -> localhost:54321.*2 connections/u),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledWith({ hostId: "host_remote", port: 5173 });
});

it("shows the mapping and says when the local port was busy", () => {
  expect(describeForward({ ...forward, localPort: 5173 })).toBe(
    "5173 -> localhost:5173",
  );
  expect(describeForward(forward)).toContain("local port 5173 was busy");
});
