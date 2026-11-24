import { isIP } from "node:net";
import type { HookUrlScope, HookUrlSource } from "./rpc-types.js";

export const WEBHOOK_ROUTE_PATH = "/webhook";
const PLUGIN_ID = "automations";

export const WEBHOOK_PATH = `/api/v1/plugins/${PLUGIN_ID}/http${WEBHOOK_ROUTE_PATH}`;

const PATH_ONLY_RULE = `Forward only ${WEBHOOK_PATH} to this server and answer 404 for every other path: the rest of the bb API has no login. Set the proxy's upstream Host header to this server's own address (for example 127.0.0.1), because bb refuses other host names.`;

const REACH_ADVICE = `To receive events from elsewhere, put a reverse proxy or tunnel in front. ${PATH_ONLY_RULE} Then set the webhookBaseUrl plugin setting to the proxy's public address. The automations skill has Caddy, nginx and cloudflared rules.`;

export interface WebhookBase {
  baseUrl: string;
  source: HookUrlSource;
  scope: HookUrlScope;
  warning: string;
}

export function isValidWebhookBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function ipv4Octets(host: string): number[] | null {
  if (isIP(host) !== 4) return null;
  return host.split(".").map(Number);
}

export function classifyHost(rawHost: string): HookUrlScope {
  const host = rawHost.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return "loopback";
  }
  const octets = ipv4Octets(host);
  if (octets !== null) {
    const [first = 0, second = 0] = octets;
    if (first === 127 || first === 0) return "loopback";
    if (first === 100 && second >= 64 && second <= 127) return "tailnet";
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    ) {
      return "private-network";
    }
    return "public";
  }
  if (isIP(host) === 6) {
    if (host.startsWith("fd7a:115c:a1e0")) return "tailnet";
    if (/^f[cd]/u.test(host) || host.startsWith("fe80")) {
      return "private-network";
    }
    return "public";
  }
  if (host.endsWith(".ts.net")) return "tailnet";
  if (host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".")) {
    return "private-network";
  }
  return "public";
}

function warningFor(scope: HookUrlScope): string {
  switch (scope) {
    case "public":
      return `Anyone on the internet can reach this address. ${PATH_ONLY_RULE}`;
    case "loopback":
      return `Only this machine can reach this address. ${REACH_ADVICE}`;
    case "tailnet":
      return `Only devices on your tailnet can reach this address, so hosted senders such as GitHub cannot. Senders on the tailnet can use it as it is. ${REACH_ADVICE}`;
    case "private-network":
      return `Only devices on your local network can reach this address, so hosted senders such as GitHub cannot. Senders on the same network can use it as it is. ${REACH_ADVICE}`;
  }
}

export function resolveWebhookBase(args: {
  settingValue: string | undefined;
  appUrl: string | null;
  loopbackBaseUrl: string;
}): WebhookBase {
  const candidates: Array<[HookUrlSource, string | null | undefined]> = [
    ["setting", args.settingValue],
    ["app-url", args.appUrl],
  ];
  for (const [source, value] of candidates) {
    if (value !== undefined && value !== null && isValidWebhookBaseUrl(value)) {
      const baseUrl = value.replace(/\/+$/u, "");
      const scope = classifyHost(new URL(baseUrl).hostname);
      return { baseUrl, source, scope, warning: warningFor(scope) };
    }
  }
  const baseUrl = args.loopbackBaseUrl.replace(/\/+$/u, "");
  return {
    baseUrl,
    source: "loopback",
    scope: "loopback",
    warning: warningFor("loopback"),
  };
}

export function webhookUrl(base: WebhookBase, hookId: string): string {
  return `${base.baseUrl}/api/v1/plugins/${PLUGIN_ID}/http${WEBHOOK_ROUTE_PATH}?hook=${hookId}`;
}
