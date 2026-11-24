import { forwardHostPort, type HostPortForward } from "@bb/host-port-forward";
import { hostPortRelayPath } from "@bb/server-contract";
import type {
  BbDesktopHostPortEnsureRequest,
  BbDesktopHostPortForward,
} from "@bb/desktop-contract";

interface ActiveForward {
  hostId: string;
  port: number;
  serverOrigin: string;
  forward: HostPortForward;
  connections: number;
}

export interface HostPortForwardManagerOptions {
  readCookieHeader(origin: string): Promise<string | null>;
  onChange(forwards: BbDesktopHostPortForward[]): void;
  forward?: typeof forwardHostPort;
}

export class HostPortRequestError extends Error {}

function keyOf(origin: string, hostId: string, port: number): string {
  return `${origin}|${hostId}|${port}`;
}

export function validateRelayUrl(args: {
  request: BbDesktopHostPortEnsureRequest;
  senderOrigin: string;
}): { serverOrigin: string } {
  let url: URL;
  try {
    url = new URL(args.request.relayUrl);
  } catch {
    throw new HostPortRequestError("The relay URL is not a URL.");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new HostPortRequestError("The relay URL must be a ws or wss URL.");
  const serverOrigin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  if (serverOrigin !== args.senderOrigin)
    throw new HostPortRequestError(
      "A relay can only go through the server this window shows.",
    );
  const expectedPath = hostPortRelayPath(
    args.request.hostId,
    args.request.port,
  );
  if (!url.pathname.endsWith(expectedPath) || url.search !== "")
    throw new HostPortRequestError("The relay URL does not match the request.");
  return { serverOrigin };
}

export class HostPortForwardManager {
  private readonly active = new Map<string, ActiveForward>();
  private readonly starting = new Map<
    string,
    Promise<BbDesktopHostPortForward>
  >();
  private readonly forward: typeof forwardHostPort;
  private stops = 0;

  constructor(private readonly options: HostPortForwardManagerOptions) {
    this.forward = options.forward ?? forwardHostPort;
  }

  list(): BbDesktopHostPortForward[] {
    return [...this.active.values()].map((entry) => this.describe(entry));
  }

  async ensure(
    request: BbDesktopHostPortEnsureRequest,
    senderOrigin: string,
  ): Promise<BbDesktopHostPortForward> {
    const { serverOrigin } = validateRelayUrl({ request, senderOrigin });
    const key = keyOf(serverOrigin, request.hostId, request.port);
    const existing = this.active.get(key);
    if (existing !== undefined) return this.describe(existing);
    const pending = this.starting.get(key);
    if (pending !== undefined) return pending;
    const started = this.start(key, request, serverOrigin).finally(() => {
      this.starting.delete(key);
    });
    this.starting.set(key, started);
    return started;
  }

  private async start(
    key: string,
    request: BbDesktopHostPortEnsureRequest,
    serverOrigin: string,
  ): Promise<BbDesktopHostPortForward> {
    const stops = this.stops;
    const cookie = await this.options.readCookieHeader(serverOrigin);
    const entry: ActiveForward = {
      hostId: request.hostId,
      port: request.port,
      serverOrigin,
      connections: 0,
      forward: await this.forward({
        relayUrl: request.relayUrl,
        localPort: request.preferredLocalPort,
        fallbackWhenBusy: true,
        headers: cookie === null ? undefined : { cookie },
        onConnectionsChanged: (count) => {
          entry.connections = count;
          this.options.onChange(this.list());
        },
      }),
    };
    if (stops !== this.stops) {
      await entry.forward.close();
      throw new HostPortRequestError("The port forwards were stopped.");
    }
    this.active.set(key, entry);
    this.options.onChange(this.list());
    return this.describe(entry);
  }

  async stop(args: {
    hostId: string;
    port: number;
    senderOrigin: string;
  }): Promise<void> {
    const key = keyOf(args.senderOrigin, args.hostId, args.port);
    const entry = this.active.get(key);
    if (entry === undefined) return;
    this.active.delete(key);
    await entry.forward.close();
    this.options.onChange(this.list());
  }

  async stopAll(): Promise<void> {
    this.stops += 1;
    const entries = [...this.active.values()];
    this.active.clear();
    await Promise.all(entries.map((entry) => entry.forward.close()));
    this.options.onChange([]);
  }

  private describe(entry: ActiveForward): BbDesktopHostPortForward {
    return {
      hostId: entry.hostId,
      port: entry.port,
      localPort: entry.forward.localPort,
      connections: entry.connections,
      serverOrigin: entry.serverOrigin,
    };
  }
}
