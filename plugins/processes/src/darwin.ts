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

export type RunTool = (
  command: string,
  args: readonly string[],
) => Promise<string | null>;

export interface PsRow {
  pid: number;
  ppid: number;
  uid: number;
  rssBytes: number;
  cpuTimeMs: number;
  startToken: string;
  startedAt: number | null;
  name: string;
}

export function parsePsCpuTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (match === null) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return Math.round(
    (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000,
  );
}

const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+(?:\w{3}\s+\d+|\d+\s+\w{3})\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/;

export function normalizeLstart(value: string): string {
  const spaced = value.replace(/\s+/g, " ");
  const dayFirst = /^(\w{3}) (\d+) (\w{3}) (\d\d:\d\d:\d\d) (\d{4})$/.exec(
    spaced,
  );
  return dayFirst === null
    ? spaced
    : `${dayFirst[1]} ${dayFirst[3]} ${dayFirst[2]} ${dayFirst[4]} ${dayFirst[5]}`;
}

export function parsePsTable(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const match = PS_ROW.exec(line);
    if (match === null) continue;
    const cpuTimeMs = parsePsCpuTime(match[5]!);
    if (cpuTimeMs === null) continue;
    const startToken = normalizeLstart(match[6]!);
    const startedAt = Date.parse(startToken);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      cpuTimeMs,
      startToken,
      startedAt: Number.isNaN(startedAt) ? null : startedAt,
      name: path.basename(match[7]!.trim()),
    });
  }
  return rows;
}

export interface PsEnvironmentEntry {
  threadId: string | null;
  toolCallId: string | null;
  argv: string[];
  command: string | null;
  hidden: boolean;
}

function parsePsCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match !== null) commands.set(Number(match[1]), match[2]!.trimEnd());
  }
  return commands;
}

export function parsePsEnvironment(
  plain: string,
  withEnvironment: string,
): Map<number, PsEnvironmentEntry> {
  const commands = parsePsCommands(plain);
  const entries = new Map<number, PsEnvironmentEntry>();
  for (const [pid, line] of parsePsCommands(withEnvironment)) {
    const command = commands.get(pid) ?? line;
    const environment = line.startsWith(command)
      ? line.slice(command.length)
      : "";
    const matches = [...environment.matchAll(/(?:^|\s)BB_THREAD_ID=(\S+)/g)];
    const toolCalls = [
      ...environment.matchAll(/(?:^|\s)CODEX_TOOL_CALL_ID=(\S+)/g),
    ];
    entries.set(pid, {
      threadId: matches.at(-1)?.[1] ?? null,
      toolCallId: toolCalls.at(-1)?.[1] ?? null,
      argv: command.trim().split(/\s+/).slice(0, 2),
      command: cleanCommand([command.trim()]),
      hidden: !/(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(environment),
    });
  }
  return entries;
}

export function parseLsofListeners(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n") || pid === null) continue;
    const name = line.slice(1);
    const separator = name.lastIndexOf(":");
    const port = Number(name.slice(separator + 1));
    if (separator === -1 || !Number.isInteger(port)) continue;
    const host = name.slice(0, separator).replace(/^\[|\]$/g, "");
    sockets.push({ pid, port, address: host === "*" ? "0.0.0.0" : host });
  }
  return sockets;
}

export async function readDarwinSnapshot(
  uid: number,
  run: RunTool,
): Promise<ProcessSnapshot | null> {
  const [ps, commands, environment, lsof] = await Promise.all([
    run("/bin/ps", ["-axo", "pid=,ppid=,uid=,rss=,time=,lstart=,comm="]),
    run("/bin/ps", ["-axww", "-o", "pid=,command="]),
    run("/bin/ps", ["-axwwE", "-o", "pid=,command="]),
    run("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-u",
      String(uid),
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fpn",
    ]),
  ]);
  if (ps === null || commands === null || environment === null || lsof === null)
    return null;
  const environments = parsePsEnvironment(commands, environment);
  const table = new Map<number, ProcessEntry>();
  const usage = new Map<number, ProcessUsage>();
  const others: OtherProcess[] = [];
  const hidden = new Set<number>();
  for (const row of parsePsTable(ps)) {
    if (row.uid !== uid) {
      others.push({
        pid: row.pid,
        name: row.name,
        startToken: row.startToken,
        cpuTimeMs: row.cpuTimeMs,
        rssBytes: row.rssBytes,
      });
      continue;
    }
    const details = environments.get(row.pid);
    table.set(row.pid, {
      pid: row.pid,
      ppid: row.ppid,
      name: row.name,
      threadId: details?.threadId ?? null,
      toolCallId: details?.toolCallId ?? null,
      launcher: isLauncher(row.name, details?.argv ?? []),
    });
    usage.set(row.pid, {
      startToken: row.startToken,
      startedAt: row.startedAt,
      cpuTimeMs: row.cpuTimeMs,
      rssBytes: row.rssBytes,
      command: details?.command ?? null,
    });
    if (details === undefined || details.hidden) hidden.add(row.pid);
  }
  inheritHiddenEnvironment(table, hidden);
  return {
    table,
    sockets: parseLsofListeners(lsof),
    usage,
    others,
    threads: SUPPORTED,
    listeners: SUPPORTED,
  };
}

export async function readDarwinCwd(
  pid: number,
  run: RunTool,
): Promise<string | null> {
  const output = await run("/usr/sbin/lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ]);
  const line = output?.split("\n").find((value) => value.startsWith("n"));
  return line === undefined ? null : line.slice(1);
}
