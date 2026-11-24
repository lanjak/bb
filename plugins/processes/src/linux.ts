import { readFile, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import {
  inheritHiddenEnvironment,
  isLauncher,
  type ListeningSocket,
  type ProcessEntry,
} from "./attribute.js";
import {
  SUPPORTED,
  cleanCommand,
  type OtherProcess,
  type ProcessSnapshot,
  type ProcessUsage,
} from "./snapshot.js";

const LISTEN_STATE = "0A";
const THREAD_ID_PREFIX = "BB_THREAD_ID=";
const TOOL_CALL_ID_PREFIX = "CODEX_TOOL_CALL_ID=";

export interface LinuxClock {
  pageSize: number;
  clockTicks: number;
  bootTimeMs: number | null;
}

export const DEFAULT_LINUX_CLOCK: LinuxClock = {
  pageSize: 4096,
  clockTicks: 100,
  bootTimeMs: null,
};

export function parseBootTime(content: string): number | null {
  const match = /^btime\s+(\d+)$/m.exec(content);
  return match === null ? null : Number(match[1]) * 1000;
}

function hexBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2)
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  return bytes;
}

export function decodeProcAddress(hex: string): string {
  const words: number[][] = [];
  for (let index = 0; index < hex.length; index += 8)
    words.push(hexBytes(hex.slice(index, index + 8)).reverse());
  const bytes = words.flat();
  if (bytes.length === 4) return bytes.join(".");
  const v4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (v4Mapped) return `::ffff:${bytes.slice(12).join(".")}`;
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2)
    groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  const joined = groups.join(":");
  if (joined === "0:0:0:0:0:0:0:0") return "::";
  if (joined === "0:0:0:0:0:0:0:1") return "::1";
  return joined;
}

export function parseProcNetTcp(
  content: string,
  uid: number,
): Map<string, { port: number; address: string }> {
  const listening = new Map<string, { port: number; address: string }>();
  for (const line of content.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
    if (Number(fields[7]) !== uid) continue;
    const [addressHex, portHex] = fields[1]!.split(":");
    if (addressHex === undefined || portHex === undefined) continue;
    listening.set(fields[9]!, {
      port: Number.parseInt(portHex, 16),
      address: decodeProcAddress(addressHex),
    });
  }
  return listening;
}

export interface ParsedStat {
  ppid: number;
  cpuTicks: number;
  startTicks: number;
  rssPages: number;
}

function statNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseProcStat(content: string): ParsedStat | null {
  const close = content.lastIndexOf(")");
  if (close === -1) return null;
  const fields = content.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  if (!Number.isInteger(ppid)) return null;
  return {
    ppid,
    cpuTicks: statNumber(fields[11]) + statNumber(fields[12]),
    startTicks: statNumber(fields[19]),
    rssPages: statNumber(fields[21]),
  };
}

export function environHidden(content: string | null): boolean {
  return (
    content === null ||
    !content.split("\0").some((value) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value))
  );
}

function environValue(content: string, prefix: string): string | null {
  const entry = content.split("\0").find((value) => value.startsWith(prefix));
  const value = entry?.slice(prefix.length) ?? "";
  return value === "" ? null : value;
}

export function threadIdFromEnviron(content: string): string | null {
  return environValue(content, THREAD_ID_PREFIX);
}

export function toolCallIdFromEnviron(content: string): string | null {
  return environValue(content, TOOL_CALL_ID_PREFIX);
}

const READ_BATCH = 64;

async function mapInBatches<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += READ_BATCH)
    results.push(
      ...(await Promise.all(items.slice(index, index + READ_BATCH).map(map))),
    );
  return results;
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

type ProcessRead =
  | {
      kind: "own";
      entry: ProcessEntry;
      usage: ProcessUsage;
      hidden: boolean;
    }
  | { kind: "other"; other: OtherProcess };

function usageOf(
  parsed: ParsedStat,
  clock: LinuxClock,
  command: string | null,
): ProcessUsage {
  return {
    startToken: String(parsed.startTicks),
    startedAt:
      clock.bootTimeMs === null
        ? null
        : clock.bootTimeMs + (parsed.startTicks * 1000) / clock.clockTicks,
    cpuTimeMs: (parsed.cpuTicks * 1000) / clock.clockTicks,
    rssBytes: parsed.rssPages * clock.pageSize,
    command,
  };
}

async function readProcess(
  procRoot: string,
  pid: number,
  uid: number,
  clock: LinuxClock,
): Promise<ProcessRead | null> {
  const directory = path.join(procRoot, String(pid));
  let owner: number;
  try {
    owner = (await stat(directory)).uid;
  } catch {
    return null;
  }
  const own = owner === uid;
  const [statContent, comm, environ] = await Promise.all([
    readOptional(path.join(directory, "stat")),
    readOptional(path.join(directory, "comm")),
    own ? readOptional(path.join(directory, "environ")) : null,
  ]);
  const parsed = statContent === null ? null : parseProcStat(statContent);
  if (parsed === null || comm === null) return null;
  const name = comm.trim();
  if (!own) {
    const usage = usageOf(parsed, clock, null);
    return {
      kind: "other",
      other: {
        pid,
        name,
        startToken: usage.startToken,
        cpuTimeMs: usage.cpuTimeMs,
        rssBytes: usage.rssBytes,
      },
    };
  }
  const hidden = environHidden(environ);
  const threadId =
    environ === null || hidden ? null : threadIdFromEnviron(environ);
  const cmdline =
    threadId === null && !hidden
      ? null
      : await readOptional(path.join(directory, "cmdline"));
  const argv = cmdline?.split("\0") ?? [];
  return {
    kind: "own",
    entry: {
      pid,
      ppid: parsed.ppid,
      name,
      threadId,
      toolCallId:
        environ === null || hidden ? null : toolCallIdFromEnviron(environ),
      launcher: isLauncher(name, argv),
    },
    usage: usageOf(parsed, clock, cleanCommand(argv)),
    hidden,
  };
}

async function socketInodes(procRoot: string, pid: number): Promise<string[]> {
  const directory = path.join(procRoot, String(pid), "fd");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const links = await mapInBatches(entries, (entry) =>
    readlink(path.join(directory, entry)).catch(() => null),
  );
  return links.flatMap((link) => {
    const match = link === null ? null : /^socket:\[(\d+)\]$/.exec(link);
    return match === null ? [] : [match[1]!];
  });
}

export async function readLinuxSnapshot(
  uid: number,
  procRoot = "/proc",
  clock: LinuxClock = DEFAULT_LINUX_CLOCK,
): Promise<ProcessSnapshot> {
  const listening = new Map<string, { port: number; address: string }>();
  for (const file of ["tcp", "tcp6"]) {
    const content = await readOptional(path.join(procRoot, "net", file));
    if (content === null) continue;
    for (const [inode, socket] of parseProcNetTcp(content, uid))
      listening.set(inode, socket);
  }
  const pids = (await readdir(procRoot))
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number);
  const entries = await mapInBatches(pids, (pid) =>
    readProcess(procRoot, pid, uid, clock),
  );
  const table = new Map<number, ProcessEntry>();
  const usage = new Map<number, ProcessUsage>();
  const others: OtherProcess[] = [];
  const hidden = new Set<number>();
  for (const read of entries) {
    if (read === null) continue;
    if (read.kind === "other") {
      others.push(read.other);
      continue;
    }
    table.set(read.entry.pid, read.entry);
    usage.set(read.entry.pid, read.usage);
    if (read.hidden) hidden.add(read.entry.pid);
  }
  inheritHiddenEnvironment(table, hidden);
  const sockets: ListeningSocket[] = [];
  const snapshot = (): ProcessSnapshot => ({
    table,
    sockets,
    usage,
    others,
    threads: SUPPORTED,
    listeners: SUPPORTED,
  });
  if (listening.size === 0) return snapshot();
  for (const entry of table.values()) {
    if (entry.threadId === null) continue;
    for (const inode of await socketInodes(procRoot, entry.pid)) {
      const socket = listening.get(inode);
      if (socket !== undefined) sockets.push({ pid: entry.pid, ...socket });
    }
  }
  return snapshot();
}

export async function readLinuxClock(
  run: (command: string, args: readonly string[]) => Promise<string | null>,
  procRoot = "/proc",
): Promise<LinuxClock> {
  const [pageSize, clockTicks, stat] = await Promise.all([
    run("getconf", ["PAGESIZE"]),
    run("getconf", ["CLK_TCK"]),
    readOptional(path.join(procRoot, "stat")),
  ]);
  const positive = (value: string | null, fallback: number): number => {
    const parsed = Number(value?.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    pageSize: positive(pageSize, DEFAULT_LINUX_CLOCK.pageSize),
    clockTicks: positive(clockTicks, DEFAULT_LINUX_CLOCK.clockTicks),
    bootTimeMs: stat === null ? null : parseBootTime(stat),
  };
}

export async function readLinuxCwd(
  pid: number,
  procRoot = "/proc",
): Promise<string | null> {
  try {
    return await readlink(path.join(procRoot, String(pid), "cwd"));
  } catch {
    return null;
  }
}
