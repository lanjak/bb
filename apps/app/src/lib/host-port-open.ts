import type { BbDesktopHostPortsApi } from "@bb/desktop-contract";

export type HostPortOpenResult =
  | { via: "local"; url: string }
  | { via: "forward"; url: string; localPort: number }
  | { via: "unreachable"; reason: string };

export type LoopbackProtocol = "http" | "https";

export interface HostPortOpenRequest {
  hostId: string;
  port: number;
  path?: string;
  protocol: LoopbackProtocol;
}

export interface HostPortOpenDependencies {
  localHostId: string | null;
  desktopHostPorts: BbDesktopHostPortsApi | null;
  relayUrl(request: { hostId: string; port: number }): string;
}

export const WEB_UNREACHABLE_REASON =
  "This device cannot reach that machine's ports. Forward the port from the desktop app, or run `bb machine forward <port> --machine <machine>` on this computer.";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "0.0.0.0", "[::1]", "[::]"]);
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const DEFAULT_PORTS: Record<LoopbackProtocol, number> = {
  http: 80,
  https: 443,
};

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function normalizeOpenPath(path: string | undefined): string {
  if (path === undefined || path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function parseLoopbackUrl(
  href: string,
): { protocol: LoopbackProtocol; port: number; path: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const protocol =
    url.protocol === "http:"
      ? "http"
      : url.protocol === "https:"
        ? "https"
        : null;
  if (
    protocol === null ||
    !(LOOPBACK_HOSTNAMES.has(url.hostname) || LOOPBACK_IPV4.test(url.hostname))
  )
    return null;
  const port = url.port === "" ? DEFAULT_PORTS[protocol] : Number(url.port);
  if (!isValidPort(port)) return null;
  return { protocol, port, path: `${url.pathname}${url.search}${url.hash}` };
}

export async function resolveHostPort(
  dependencies: HostPortOpenDependencies,
  request: HostPortOpenRequest,
): Promise<HostPortOpenResult> {
  if (!isValidPort(request.port))
    return {
      via: "unreachable",
      reason: "The port must be an integer from 1 to 65535.",
    };
  const path = normalizeOpenPath(request.path);
  if (
    dependencies.localHostId !== null &&
    request.hostId === dependencies.localHostId
  )
    return {
      via: "local",
      url: `${request.protocol}://localhost:${request.port}${path}`,
    };
  if (dependencies.desktopHostPorts === null)
    return { via: "unreachable", reason: WEB_UNREACHABLE_REASON };
  try {
    const forward = await dependencies.desktopHostPorts.ensure({
      hostId: request.hostId,
      port: request.port,
      relayUrl: dependencies.relayUrl({
        hostId: request.hostId,
        port: request.port,
      }),
      preferredLocalPort: request.port,
    });
    return {
      via: "forward",
      localPort: forward.localPort,
      url: `${request.protocol}://localhost:${forward.localPort}${path}`,
    };
  } catch (error) {
    return {
      via: "unreachable",
      reason:
        error instanceof Error
          ? error.message
          : "The desktop app could not forward the port.",
    };
  }
}
