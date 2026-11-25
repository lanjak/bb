import type { RemoteFacts } from "../contract.js";
import type { ResolvedTarget } from "../target.js";

export interface RouteOption {
  id: string;
  displayName: string;
  urls: string[];
}

export interface InstalledMachine {
  hostId: string;
  name: string;
}

export function supportsNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 22 || (major === 22 && Number(match[2]) >= 19);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function uninstallCommand(serverUrl: string, hostId: string): string {
  return `curl -fsSL ${normalizeUrl(serverUrl)}/install.sh | sh -s -- --uninstall --host-id ${hostId}`;
}

export function probeBlockers(args: {
  destination: string;
  facts: RemoteFacts;
  route: RouteOption | null;
  machines: readonly InstalledMachine[];
}): string[] {
  const { destination, facts, route } = args;
  if (facts.os !== "Linux" && facts.os !== "Darwin")
    return [
      `bb can add Linux and macOS computers over SSH, but ${destination} reports ${facts.os}.`,
    ];
  const blockers: string[] = [];
  if (facts.node === null)
    blockers.push(
      `Node.js 22.19 or newer is required on ${destination}, and node is not on its PATH. Install it, then try again.`,
    );
  else if (!supportsNodeVersion(facts.nodeVersion ?? ""))
    blockers.push(
      `Node.js 22.19 or newer is required on ${destination}; it has ${facts.nodeVersion ?? "an unknown version"} at ${facts.node}. Upgrade it, then try again.`,
    );
  if (!facts.npm)
    blockers.push(`npm is required on ${destination} and is not on its PATH.`);
  if (!facts.curl)
    blockers.push(`curl is required on ${destination} and is not on its PATH.`);
  if (route !== null && route.urls.length > 0) {
    const probed = route.urls.map((url) =>
      facts.routes.find((entry) => entry.url === url),
    );
    const usable = probed.some(
      (entry) =>
        entry !== undefined && entry.status >= 200 && entry.status < 300,
    );
    if (!usable) {
      const answers = route.urls.map((url, index) => {
        const status = probed[index]?.status ?? 0;
        return status === 0
          ? `${url} did not answer`
          : `${url} answered HTTP ${status}`;
      });
      blockers.push(
        `${destination} cannot use this bb server through ${route.displayName}: ${answers.join(", ")}. Choose another server route or fix the network.`,
      );
    }
  }
  const routeUrls = new Set(route?.urls.map(normalizeUrl) ?? []);
  for (const install of facts.installs) {
    const machine = args.machines.find(
      (candidate) => candidate.hostId === install.hostId,
    );
    if (machine !== undefined)
      blockers.push(
        `${destination} already runs the machine ${machine.name}. Use Reconnect on that machine instead.`,
      );
    else if (routeUrls.has(normalizeUrl(install.serverUrl)))
      blockers.push(
        `${destination} has an old bb machine install for this server (${install.hostId}). Remove it there with: ${uninstallCommand(install.serverUrl, install.hostId)}`,
      );
  }
  return blockers;
}

export function probeNotes(args: {
  destination: string;
  facts: RemoteFacts;
  keepRunning: boolean;
}): string[] {
  const { destination, facts } = args;
  const notes: string[] = [];
  if (facts.os === "Darwin")
    notes.push(
      `bb installs a launch agent on ${destination}, which needs a signed-in desktop session.`,
    );
  else if (!facts.systemd)
    notes.push(
      `${destination} has no systemd, so the daemon runs without a service and does not start after a reboot.`,
    );
  else if (facts.root && !facts.container)
    notes.push(`bb installs a system service on ${destination} for root.`);
  else if (facts.linger !== true)
    notes.push(
      args.keepRunning
        ? `bb turns on lingering for ${facts.user}, so the daemon keeps running after you log out.`
        : `Lingering stays off, so the daemon stops when the last session of ${facts.user} on ${destination} ends, including the one bb uses to install it.`,
    );
  return notes;
}
