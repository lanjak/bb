import type { ListeningSocket, ProcessEntry } from "./attribute.js";

export interface ProcessUsage {
  startToken: string;
  startedAt: number | null;
  cpuTimeMs: number;
  rssBytes: number;
  command: string | null;
}

export interface OtherProcess {
  pid: number;
  name: string;
  startToken: string;
  cpuTimeMs: number;
  rssBytes: number;
}

export type Capability = { ok: true } | { ok: false; reason: string };

export interface ProcessSnapshot {
  table: Map<number, ProcessEntry>;
  sockets: ListeningSocket[];
  usage: Map<number, ProcessUsage>;
  others: OtherProcess[];
  threads: Capability;
  listeners: Capability;
}

export const SUPPORTED: Capability = { ok: true };

export function describeCapability(capability: Capability): string | null {
  return capability.ok ? null : capability.reason;
}

const MAX_COMMAND_LENGTH = 300;

export function cleanCommand(argv: readonly string[]): string | null {
  const command = argv
    .filter((part) => part !== "")
    .join(" ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim();
  if (command === "") return null;
  return command.length > MAX_COMMAND_LENGTH
    ? `${command.slice(0, MAX_COMMAND_LENGTH - 3)}...`
    : command;
}
