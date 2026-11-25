import type { ResolvedTarget } from "../target.js";
import { printableLines } from "./text.js";

const MAX_LINE_CHARS = 500;

export type SshFailure =
  | { kind: "changed"; offendingFile: string | null }
  | { kind: "unknown"; name: string }
  | { kind: "auth" }
  | { kind: "other" };

export function classifySshFailure(output: string): SshFailure {
  const stderr = printableLines(output).join("\n");
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/u.test(
      stderr,
    )
  )
    return {
      kind: "changed",
      offendingFile:
        /Offending (?:\S+ )?key in (.+):\d+/u.exec(stderr)?.[1] ?? null,
    };
  const unknown =
    /No \S+ host key is known for (\S+) and you have requested strict checking/u.exec(
      stderr,
    );
  if (unknown !== null) return { kind: "unknown", name: unknown[1]! };
  if (/Permission denied \(|Too many authentication failures/u.test(stderr))
    return { kind: "auth" };
  return { kind: "other" };
}

export function changedKeyMessage(args: {
  resolved: ResolvedTarget;
  offendingFile: string | null;
  bbKnownHosts: string;
}): string {
  const fix =
    args.offendingFile === args.bbKnownHosts
      ? `bb trusted the old key. Remove its line for ${args.resolved.knownHostsName} from ${args.bbKnownHosts} on this machine`
      : `Remove the old key with: ssh-keygen -R '${args.resolved.knownHostsName}'${args.offendingFile === null ? "" : ` -f '${args.offendingFile}'`}`;
  return `The host key of ${args.resolved.knownHostsName} has changed. Someone may be intercepting the connection, or the computer was reinstalled. ${fix}, then try again.`;
}

export function jumpHostMessage(
  name: string,
  proxyJump: string | null,
): string {
  const jump = proxyJump === null ? "" : ` (ProxyJump ${proxyJump})`;
  return `bb does not trust the host key of ${name}, which ssh connects through first${jump}. Connect to it once in a terminal on this machine, then try again.`;
}

const HINTS: ReadonlyArray<[RegExp, string]> = [
  [
    /Too many authentication failures/u,
    "The computer closed the connection after too many keys. Set an identity file for this host.",
  ],
  [
    /agent refused operation/u,
    "The ssh agent refused to sign. Unlock it, then try again.",
  ],
  [
    /UNPROTECTED PRIVATE KEY FILE/u,
    "ssh ignored the private key because other users can read it. Run chmod 600 on it.",
  ],
  [
    /Permission denied \([^)]*(?:password|keyboard-interactive)/u,
    "ssh could not sign in with a key. bb does not support password or multi-factor sign-in. Load your key into the ssh agent on this machine (ssh-add) or set an identity file.",
  ],
  [
    /Permission denied \(/u,
    "ssh could not sign in with a key. Load your key into the ssh agent on this machine (ssh-add), set an identity file, or check the user name.",
  ],
  [
    /Could not resolve hostname/u,
    "ssh could not find that host name. Check the name or your ssh config.",
  ],
  [
    /Connection refused/u,
    "Nothing accepted the connection. Check that the SSH server is running and the port is right.",
  ],
  [
    /Connection timed out|Operation timed out|No route to host|Network is unreachable/u,
    "ssh could not reach the computer. Check the network or VPN.",
  ],
  [
    /Host key verification failed/u,
    "ssh refused the host key. If ssh connects through a jump host, connect to it once in a terminal first.",
  ],
];

export function sshHint(stderr: string): string | null {
  return HINTS.find(([pattern]) => pattern.test(stderr))?.[1] ?? null;
}

export function sshFailureMessage(stderr: string, fallback: string): string {
  const lines = printableLines(stderr)
    .map((line) => line.trim().slice(0, MAX_LINE_CHARS))
    .filter((line) => line !== "");
  const detail = lines.slice(-5).join("\n") || fallback;
  const hint = sshHint(stderr);
  return (hint === null ? detail : `${hint}\n${detail}`).slice(0, 4000);
}
