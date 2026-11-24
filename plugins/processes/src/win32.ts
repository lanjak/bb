import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inheritHiddenEnvironment,
  isLauncher,
  type ProcessEntry,
} from "./attribute.js";
import type { RunTool } from "./darwin.js";
import {
  SUPPORTED,
  cleanCommand,
  type Capability,
  type OtherProcess,
  type ProcessSnapshot,
  type ProcessUsage,
} from "./snapshot.js";

const CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class BbProcessEnvironment {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsWow64Process(IntPtr handle, out bool wow64);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr handle, int informationClass, ref ProcessBasicInformation information, int length, out int returned);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr handle, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returned);
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessBasicInformation {
    public IntPtr ExitStatus;
    public IntPtr PebBaseAddress;
    public IntPtr AffinityMask;
    public IntPtr BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  const uint QueryLimitedAndRead = 0x1010;
  const int PebProcessParametersOffset = 0x20;
  const int ParametersEnvironmentOffset = 0x80;
  const int ParametersEnvironmentSizeOffset = 0x3F0;
  const int MaxEnvironmentBytes = 1048576;
  public static string CurrentUser() {
    return WindowsIdentity.GetCurrent().User.Value;
  }
  static string OwnerOf(IntPtr handle) {
    IntPtr token;
    if (!OpenProcessToken(handle, 8, out token)) return null;
    try {
      int length;
      GetTokenInformation(token, 1, IntPtr.Zero, 0, out length);
      if (length <= 0) return null;
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        if (!GetTokenInformation(token, 1, buffer, length, out length)) return null;
        return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    } finally {
      CloseHandle(token);
    }
  }
  static byte[] ReadBytes(IntPtr handle, IntPtr address, int size) {
    byte[] buffer = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(handle, address, buffer, (IntPtr)size, out read)) return null;
    return buffer;
  }
  static IntPtr ReadPointer(IntPtr handle, IntPtr address) {
    byte[] bytes = ReadBytes(handle, address, 8);
    return bytes == null ? IntPtr.Zero : (IntPtr)BitConverter.ToInt64(bytes, 0);
  }
  public static string[] Read(int pid, string currentUser) {
    IntPtr handle = OpenProcess(QueryLimitedAndRead, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      if (OwnerOf(handle) != currentUser) return null;
      bool wow64;
      if (!IsWow64Process(handle, out wow64) || wow64) return new string[] { "", "", "unreadable" };
      ProcessBasicInformation information = new ProcessBasicInformation();
      int returned;
      if (NtQueryInformationProcess(handle, 0, ref information, Marshal.SizeOf(information), out returned) != 0) return new string[] { "", "", "unreadable" };
      IntPtr parameters = ReadPointer(handle, IntPtr.Add(information.PebBaseAddress, PebProcessParametersOffset));
      if (parameters == IntPtr.Zero) return new string[] { "", "", "unreadable" };
      IntPtr environment = ReadPointer(handle, IntPtr.Add(parameters, ParametersEnvironmentOffset));
      byte[] sizeBytes = ReadBytes(handle, IntPtr.Add(parameters, ParametersEnvironmentSizeOffset), 8);
      if (environment == IntPtr.Zero || sizeBytes == null) return new string[] { "", "", "unreadable" };
      long size = BitConverter.ToInt64(sizeBytes, 0);
      if (size <= 0 || size > MaxEnvironmentBytes) return new string[] { "", "", "unreadable" };
      byte[] block = ReadBytes(handle, environment, (int)size);
      if (block == null) return new string[] { "", "", "unreadable" };
      string thread = "";
      string tool = "";
      bool any = false;
      foreach (string entry in Encoding.Unicode.GetString(block).Split((char)0)) {
        if (entry.Length == 0) continue;
        any = true;
        if (entry.StartsWith("BB_THREAD_ID=", StringComparison.Ordinal)) thread = entry.Substring(13);
        else if (entry.StartsWith("CODEX_TOOL_CALL_ID=", StringComparison.Ordinal)) tool = entry.Substring(19);
      }
      return new string[] { thread, tool, any ? "readable" : "empty" };
    } finally {
      CloseHandle(handle);
    }
  }
}
`;

export const WINDOWS_POWERSHELL = "powershell.exe";

export const WINDOWS_TABLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$rows = foreach ($process in (Get-CimInstance Win32_Process)) {
  [pscustomobject]@{
    pid = [int]$process.ProcessId
    ppid = [int]$process.ParentProcessId
    name = [string]$process.Name
    command = [string]$process.CommandLine
    cpuTimeMs = [double](([uint64]$process.KernelModeTime + [uint64]$process.UserModeTime) / 10000)
    rssBytes = [double]$process.WorkingSetSize
    startToken = if ($process.CreationDate) { $process.CreationDate.ToUniversalTime().ToString('o') } else { '' }
    startedAt = if ($process.CreationDate) { [double]([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds() } else { $null }
  }
}
[pscustomobject]@{ processes = @($rows) } | ConvertTo-Json -Compress -Depth 4
`;

export function readerHash(): string {
  return createHash("sha256").update(CSHARP).digest("hex").slice(0, 12);
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsEnvironmentScript(args: {
  pids: readonly number[];
  cacheDir: string;
}): string {
  const dll = `bb-process-environment-${readerHash()}.dll`;
  return `
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ blocked = $null; entries = @() }
try {
  if (-not [Environment]::Is64BitProcess) { throw 'PowerShell runs as a 32-bit process.' }
  $dir = ${powershellString(args.cacheDir)}
  $dll = Join-Path $dir ${powershellString(dll)}
  if (-not (Test-Path -LiteralPath $dll)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $temp = Join-Path $dir ('build-' + $PID + '.dll')
    Add-Type -TypeDefinition @'
${CSHARP}
'@ -OutputAssembly $temp
    Move-Item -LiteralPath $temp -Destination $dll -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $dll)) { $dll = $temp }
  }
  Add-Type -Path $dll
  $self = [BbProcessEnvironment]::CurrentUser()
  $entries = foreach ($target in @(${args.pids.join(",")})) {
    $environment = [BbProcessEnvironment]::Read([int]$target, $self)
    if ($null -ne $environment) {
      [pscustomobject]@{ pid = [int]$target; threadId = $environment[0]; toolCallId = $environment[1]; environment = $environment[2] }
    }
  }
  $result.entries = @($entries)
} catch {
  $result.blocked = $_.Exception.Message
}
$result | ConvertTo-Json -Compress -Depth 4
`;
}

const tableRowSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  name: z.string(),
  command: z.string().nullable(),
  cpuTimeMs: z.number(),
  rssBytes: z.number(),
  startToken: z.string(),
  startedAt: z.number().nullable(),
});
export type WindowsRow = z.infer<typeof tableRowSchema>;

const tableSchema = z.object({ processes: z.array(tableRowSchema) });

const environmentSchema = z.object({
  blocked: z.string().nullable(),
  entries: z.array(
    z.object({
      pid: z.number().int(),
      threadId: z.string(),
      toolCallId: z.string(),
      environment: z.enum(["readable", "empty", "unreadable"]),
    }),
  ),
});
export type WindowsEnvironments = z.infer<typeof environmentSchema>;

function parseJson<T>(output: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(output.trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseWindowsTable(output: string): WindowsRow[] | null {
  return parseJson(output, tableSchema)?.processes ?? null;
}

export function parseWindowsEnvironments(
  output: string,
): WindowsEnvironments | null {
  return parseJson(output, environmentSchema);
}

const IMAGE_SUFFIX = /\.exe$/i;

export function dropStaleParents(
  rows: readonly WindowsRow[],
): Map<number, number> {
  const startedAt = new Map(rows.map((row) => [row.pid, row.startedAt]));
  const parents = new Map<number, number>();
  for (const row of rows) {
    const parentStart = startedAt.get(row.ppid);
    const stale =
      parentStart !== undefined &&
      parentStart !== null &&
      row.startedAt !== null &&
      parentStart > row.startedAt;
    parents.set(row.pid, stale ? 0 : row.ppid);
  }
  return parents;
}

export type WindowsEnvironmentResult =
  | { ok: true; environments: WindowsEnvironments }
  | { ok: false; reason: string };

export function buildWindowsSnapshot(
  rows: readonly WindowsRow[],
  environment: WindowsEnvironmentResult,
): ProcessSnapshot {
  const table = new Map<number, ProcessEntry>();
  const usage = new Map<number, ProcessUsage>();
  const others: OtherProcess[] = [];
  const hidden = new Set<number>();
  const parents = dropStaleParents(rows);
  const readable =
    environment.ok && environment.environments.blocked === null
      ? new Map(environment.environments.entries.map((e) => [e.pid, e]))
      : null;
  for (const row of rows) {
    const name = row.name.replace(IMAGE_SUFFIX, "");
    const entry = readable?.get(row.pid);
    if (entry === undefined) {
      others.push({
        pid: row.pid,
        name,
        startToken: row.startToken,
        cpuTimeMs: row.cpuTimeMs,
        rssBytes: row.rssBytes,
      });
      continue;
    }
    table.set(row.pid, {
      pid: row.pid,
      ppid: parents.get(row.pid) ?? row.ppid,
      name,
      threadId: entry.threadId === "" ? null : entry.threadId,
      toolCallId: entry.toolCallId === "" ? null : entry.toolCallId,
      launcher: isLauncher(name, (row.command ?? "").split(/\s+/).slice(0, 2)),
    });
    usage.set(row.pid, {
      startToken: row.startToken,
      startedAt: row.startedAt,
      cpuTimeMs: row.cpuTimeMs,
      rssBytes: row.rssBytes,
      command: cleanCommand([row.command ?? ""]),
    });
    if (entry.environment !== "readable") hidden.add(row.pid);
  }
  inheritHiddenEnvironment(table, hidden);
  const threads: Capability = environment.ok
    ? environment.environments.blocked === null
      ? SUPPORTED
      : {
          ok: false,
          reason: `bb could not read process environments on this Windows machine: ${environment.environments.blocked}`,
        }
    : { ok: false, reason: environment.reason };
  return {
    table,
    sockets: [],
    usage,
    others,
    threads,
    listeners: {
      ok: false,
      reason: "Listening ports are not read on Windows yet.",
    },
  };
}

export interface WindowsReaderOptions {
  cacheDir: string;
  onBlocked?: (reason: string) => void;
}

function encodedArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

const BLOCKED_REASON =
  "bb could not run its environment reader on this Windows machine (it may be blocked by security software).";

export async function readWindowsSnapshot(
  run: RunTool,
  options: WindowsReaderOptions,
): Promise<ProcessSnapshot | null> {
  const tableOutput = await run(
    WINDOWS_POWERSHELL,
    encodedArgs(WINDOWS_TABLE_SCRIPT),
  );
  const rows = tableOutput === null ? null : parseWindowsTable(tableOutput);
  if (rows === null) return null;
  const output = await run(
    WINDOWS_POWERSHELL,
    encodedArgs(
      windowsEnvironmentScript({
        pids: rows.map((row) => row.pid),
        cacheDir: options.cacheDir,
      }),
    ),
  );
  const parsed = output === null ? null : parseWindowsEnvironments(output);
  const result: WindowsEnvironmentResult =
    parsed === null
      ? { ok: false, reason: BLOCKED_REASON }
      : { ok: true, environments: parsed };
  if (!result.ok) options.onBlocked?.(result.reason);
  else if (result.environments.blocked !== null)
    options.onBlocked?.(result.environments.blocked);
  return buildWindowsSnapshot(rows, result);
}
