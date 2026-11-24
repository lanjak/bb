// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopHostPortsApi } from "@bb/desktop-contract";
import { appToast } from "@/components/ui/app-toast";
import { useAppNavigationHost } from "./app-navigation-host";
import {
  WEB_UNREACHABLE_REASON,
  parseLoopbackUrl,
  resolveHostPort,
  type HostPortOpenResult,
} from "./host-port-open";
import { AppNavigationUrlHost } from "./url-open-routing";
import { useMessageLinkRouting } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";

const state = vi.hoisted(() => ({ localHostId: null as string | null }));
const webLinks = vi.hoisted(() => ({
  activate: null as ((event: MouseEvent, uri: string) => void) | null,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(activate: (event: MouseEvent, uri: string) => void) {
      webLinks.activate = activate;
    }
    activate() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-webgl", () => {
  throw new Error("WebGL unavailable");
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("@bb/client-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@bb/client-core")>();
  return {
    ...original,
    TerminalWebSocketTransport: class {
      start() {}
      sendResize() {}
      setVisible() {}
      sendInput() {}
      dispose() {}
    },
  };
});

vi.mock("@/lib/system-config-atoms", async () => {
  const { atom } = await import("jotai");
  return { localHostIdAtom: atom(async () => state.localHostId) };
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 9 }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  webLinks.activate = null;
  state.localHostId = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function relayUrl({ hostId, port }: { hostId: string; port: number }): string {
  return `ws://127.0.0.1:38886/ws/host-ports/${hostId}/${port}`;
}

function desktop(
  ensure: BbDesktopHostPortsApi["ensure"],
): BbDesktopHostPortsApi {
  return {
    ensure,
    stop: async () => undefined,
    list: async () => [],
    onChange: () => () => undefined,
  };
}

interface Scenario {
  name: string;
  localHostId: string | null;
  desktop: "none" | "same-port" | "other-port" | "fails";
  request: { hostId: string; port: number; path?: string };
  protocol?: "https";
  expected: HostPortOpenResult;
}

const SCENARIOS: Scenario[] = [
  {
    name: "this device runs the machine",
    localHostId: "host_local",
    desktop: "none",
    request: { hostId: "host_local", port: 5173, path: "/app?x=1" },
    expected: { via: "local", url: "http://localhost:5173/app?x=1" },
  },
  {
    name: "the desktop forwards to the same local port",
    localHostId: null,
    desktop: "same-port",
    request: { hostId: "host_remote", port: 5173 },
    expected: {
      via: "forward",
      localPort: 5173,
      url: "http://localhost:5173/",
    },
  },
  {
    name: "the desktop forwards to another port when the local one is busy",
    localHostId: "host_other",
    desktop: "other-port",
    request: { hostId: "host_remote", port: 5173, path: "docs" },
    expected: {
      via: "forward",
      localPort: 54321,
      url: "http://localhost:54321/docs",
    },
  },
  {
    name: "the desktop forwards an https link",
    localHostId: null,
    desktop: "other-port",
    request: { hostId: "host_remote", port: 8443, path: "/secure" },
    protocol: "https",
    expected: {
      via: "forward",
      localPort: 54321,
      url: "https://localhost:54321/secure",
    },
  },
  {
    name: "the desktop cannot forward",
    localHostId: null,
    desktop: "fails",
    request: { hostId: "host_remote", port: 5173 },
    expected: { via: "unreachable", reason: "The server refused the relay." },
  },
  {
    name: "web or mobile has no way to forward",
    localHostId: null,
    desktop: "none",
    request: { hostId: "host_remote", port: 5173 },
    expected: { via: "unreachable", reason: WEB_UNREACHABLE_REASON },
  },
  {
    name: "the port is out of range",
    localHostId: "host_local",
    desktop: "none",
    request: { hostId: "host_local", port: 70000 },
    expected: {
      via: "unreachable",
      reason: "The port must be an integer from 1 to 65535.",
    },
  },
];

function desktopFor(scenario: Scenario) {
  const ensure = vi.fn<BbDesktopHostPortsApi["ensure"]>(async (request) => {
    if (scenario.desktop === "fails")
      throw new Error("The server refused the relay.");
    return {
      hostId: request.hostId,
      port: request.port,
      localPort: scenario.desktop === "other-port" ? 54321 : request.port,
      connections: 0,
      serverOrigin: "http://127.0.0.1:38886",
    };
  });
  return {
    ensure,
    api: scenario.desktop === "none" ? null : desktop(ensure),
  };
}

function linkHref(scenario: Scenario): string {
  const path = scenario.request.path ?? "/";
  return `${scenario.protocol ?? "http"}://localhost:${scenario.request.port}${path.startsWith("/") ? path : `/${path}`}`;
}

describe("opening a machine's port", () => {
  describe.each(SCENARIOS)("$name", (scenario) => {
    it("resolves to the same result in the shared resolver", async () => {
      const { api, ensure } = desktopFor(scenario);
      await expect(
        resolveHostPort(
          {
            localHostId: scenario.localHostId,
            desktopHostPorts: api,
            relayUrl,
          },
          { ...scenario.request, protocol: scenario.protocol ?? "http" },
        ),
      ).resolves.toEqual(scenario.expected);
      if (scenario.desktop !== "none")
        expect(ensure).toHaveBeenCalledWith({
          hostId: scenario.request.hostId,
          port: scenario.request.port,
          relayUrl: relayUrl(scenario.request),
          preferredLocalPort: scenario.request.port,
        });
      else expect(ensure).not.toHaveBeenCalled();
    });

    it("gives the plugin, thread link and terminal link callers that result, and opens the same URL", async () => {
      state.localHostId = scenario.localHostId;
      const { api, ensure } = desktopFor(scenario);
      const external = vi.fn();
      vi.stubGlobal("bbDesktop", {
        ...(api === null ? {} : { hostPorts: api }),
        openExternalUrl: external,
      });
      const toast = vi.spyOn(appToast, "error").mockImplementation(() => "t");
      const pluginResults: HostPortOpenResult[] = [];
      const link: { open: ((href: string) => boolean) | null } = { open: null };

      function PluginCaller() {
        const navigation = useAppNavigationHost();
        useEffect(() => {
          void navigation
            .openHostPort({
              ...scenario.request,
              protocol: scenario.protocol ?? "http",
              target: "external",
            })
            .then((result) => pluginResults.push(result));
        }, [navigation]);
        return null;
      }
      function LinkCaller() {
        const routing = useMessageLinkRouting("thr_1");
        useEffect(() => {
          link.open = (href) => routing?.onOpenLink?.({ href }) ?? false;
        }, [routing]);
        return null;
      }

      render(
        <AppNavigationUrlHost>
          <PluginCaller />
          <ThreadTimelineNavigationProvider
            environmentId="env_1"
            hostId={scenario.request.hostId}
            onOpenLocalFileLink={() => false}
            resolveMentionLink={() => null}
            threadId="thr_1"
            workspaceRootPath={undefined}
          >
            <LinkCaller />
          </ThreadTimelineNavigationProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              hostId: scenario.request.hostId,
              status: "running",
            })}
          />
        </AppNavigationUrlHost>,
      );

      await waitFor(() => expect(pluginResults).toHaveLength(1));
      expect(pluginResults[0]).toEqual(scenario.expected);
      if (scenario.request.port > 65535) return;
      const expected = scenario.expected;
      const opened = async (count: number) => {
        if (expected.via === "unreachable")
          await waitFor(() =>
            expect(
              toast.mock.calls.filter(
                ([message]) => message === expected.reason,
              ),
            ).toHaveLength(count - 1),
          );
        else
          await waitFor(() =>
            expect(external.mock.calls).toEqual(
              Array.from({ length: count }, () => [expected.url]),
            ),
          );
      };
      await opened(1);
      await waitFor(() => expect(webLinks.activate).not.toBeNull(), {
        timeout: 10_000,
      });
      expect(link.open!(linkHref(scenario))).toBe(true);
      await opened(2);
      webLinks.activate!(
        new MouseEvent("click", { button: 0, ctrlKey: true, metaKey: true }),
        linkHref(scenario),
      );
      await opened(3);
      expect(ensure.mock.calls.length).toBe(
        scenario.desktop === "none" ? 0 : 3,
      );
    });
  });

  it("treats http and https links to this device's own addresses as ports", () => {
    expect(parseLoopbackUrl("http://localhost:5173/a?b=1#c")).toEqual({
      protocol: "http",
      port: 5173,
      path: "/a?b=1#c",
    });
    for (const [href, protocol, port] of [
      ["http://127.0.0.1/", "http", 80],
      ["http://127.8.9.10:3000/", "http", 3000],
      ["http://0.0.0.0:8000/", "http", 8000],
      ["http://[::1]:3000", "http", 3000],
      ["http://[::]:8000/", "http", 8000],
      ["https://localhost:5173/", "https", 5173],
      ["https://127.0.0.1/", "https", 443],
    ] as const)
      expect(parseLoopbackUrl(href), href).toEqual({
        protocol,
        port,
        path: "/",
      });
    for (const href of [
      "http://192.168.1.5:3000/",
      "http://128.0.0.1:3000/",
      "http://localhost.evil.example:3000/",
      "http://127.0.0.1.evil.example:3000/",
      "http://localhost:70000/",
      "ws://localhost:3000/",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(parseLoopbackUrl(href), href).toBeNull();
  });
});
