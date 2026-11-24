import { describe, expect, it } from "vitest";
import {
  attributeProcesses,
  attributeServers,
  descendants,
} from "./attribute.js";
import {
  WINDOWS_TABLE_SCRIPT,
  buildWindowsSnapshot,
  dropStaleParents,
  parseWindowsEnvironments,
  parseWindowsTable,
  readWindowsSnapshot,
  readerHash,
  windowsEnvironmentScript,
  type WindowsEnvironmentResult,
  type WindowsRow,
} from "./win32.js";

const T0 = 1_700_000_000_000;

function row(
  pid: number,
  ppid: number,
  name: string,
  overrides: Partial<WindowsRow> = {},
): WindowsRow {
  return {
    pid,
    ppid,
    name,
    command: null,
    cpuTimeMs: 100,
    rssBytes: 4096,
    startToken: `2026-11-24T00:00:${String(pid % 60).padStart(2, "0")}.0000000Z`,
    startedAt: T0 + pid,
    ...overrides,
  };
}

function environments(
  entries: Array<{
    pid: number;
    threadId?: string;
    environment?: "readable" | "empty" | "unreadable";
  }>,
  blocked: string | null = null,
): WindowsEnvironmentResult {
  return {
    ok: true,
    environments: {
      blocked,
      entries: entries.map((entry) => ({
        pid: entry.pid,
        threadId: entry.threadId ?? "",
        toolCallId: "",
        environment: entry.environment ?? "readable",
      })),
    },
  };
}

const AGENT_TREE: WindowsRow[] = [
  row(4, 0, "System"),
  row(100, 4, "node.exe"),
  row(110, 100, "node.exe"),
  row(200, 110, "claude.exe"),
  row(210, 200, "pwsh.exe"),
  row(220, 210, "python.exe", { command: "python -m http.server\u0000 8000" }),
];

const AGENT_ENVIRONMENTS = environments([
  { pid: 100 },
  { pid: 110 },
  { pid: 200, threadId: "thr_w" },
  { pid: 210, threadId: "thr_w" },
  { pid: 220, threadId: "thr_w" },
]);

describe("Windows process snapshot", () => {
  it("separates the user's processes from others and reads thread ids and usage", () => {
    const snapshot = buildWindowsSnapshot(AGENT_TREE, AGENT_ENVIRONMENTS);
    expect(snapshot.threads).toEqual({ ok: true });
    expect(snapshot.others.map((entry) => entry.name)).toEqual(["System"]);
    expect(snapshot.table.get(220)).toMatchObject({
      name: "python",
      threadId: "thr_w",
    });
    expect(snapshot.usage.get(220)).toMatchObject({
      cpuTimeMs: 100,
      command: "python -m http.server  8000",
    });
  });

  it("finds a stoppable command under the agent, and the agent is not stoppable", () => {
    const snapshot = buildWindowsSnapshot(AGENT_TREE, AGENT_ENVIRONMENTS);
    const result = attributeProcesses({
      table: snapshot.table,
      sockets: [],
      daemonPid: 100,
    });
    expect(result.processes.get(200)?.role).toBe("agent");
    expect(result.processes.get(220)).toMatchObject({
      role: "command",
      rootPid: 220,
    });
    expect(result.roots.get(220)).toBe("thr_w");
    expect(result.roots.has(200)).toBe(false);
    expect(
      attributeServers({
        table: snapshot.table,
        sockets: [],
        daemonPid: 100,
        threadId: null,
      }),
    ).toEqual([]);
  });

  it("roots a Codex command that runs under powershell or cmd", () => {
    const rows = [
      row(4, 0, "System"),
      row(100, 4, "node.exe"),
      row(110, 100, "node.exe"),
      row(200, 110, "codex.exe"),
      row(210, 200, "powershell.exe"),
      row(220, 210, "node.exe"),
      row(230, 200, "cmd.exe"),
      row(240, 230, "npm.cmd"),
    ];
    const snapshot = buildWindowsSnapshot(
      rows,
      environments([
        { pid: 100 },
        { pid: 110 },
        { pid: 200, threadId: "thr_w" },
        { pid: 210, threadId: "thr_w" },
        { pid: 220, threadId: "thr_w" },
        { pid: 230, threadId: "thr_w" },
        { pid: 240, threadId: "thr_w" },
      ]),
    );
    const result = attributeProcesses({
      table: snapshot.table,
      sockets: [],
      daemonPid: 100,
    });
    expect(result.processes.get(220)).toMatchObject({ rootPid: 220 });
    expect(result.processes.get(240)).toMatchObject({ rootPid: 240 });
    expect(result.processes.get(210)?.role).toBe("agent");
  });

  it("gives a process whose environment cannot be read the thread of its parent", () => {
    const snapshot = buildWindowsSnapshot(
      [row(200, 1, "claude.exe"), row(210, 200, "legacy.exe")],
      environments([
        { pid: 200, threadId: "thr_w" },
        { pid: 210, environment: "unreadable" },
      ]),
    );
    expect(snapshot.table.get(210)?.threadId).toBe("thr_w");
  });

  it("reports why threads are unsupported when the reader is blocked, and keeps every process as a top process", () => {
    const snapshot = buildWindowsSnapshot(
      AGENT_TREE,
      environments([], "Cannot add type. Constrained language mode."),
    );
    expect(snapshot.threads).toEqual({
      ok: false,
      reason: expect.stringContaining("Constrained language mode"),
    });
    expect(snapshot.table.size).toBe(0);
    expect(snapshot.others).toHaveLength(AGENT_TREE.length);
  });
});

describe("Windows listening ports", () => {
  it("attributes a listening port to the thread that started it, and ignores other listeners", () => {
    const rows = [...AGENT_TREE, row(300, 1, "postgres.exe")];
    const snapshot = buildWindowsSnapshot(
      rows,
      environments([
        { pid: 100 },
        { pid: 110 },
        { pid: 200, threadId: "thr_w" },
        { pid: 210, threadId: "thr_w" },
        { pid: 220, threadId: "thr_w" },
        { pid: 300 },
      ]),
      {
        listeners: [
          { pid: 220, port: 8000, address: "127.0.0.1" },
          { pid: 300, port: 5432, address: "127.0.0.1" },
          { pid: 4, port: 445, address: "0.0.0.0" },
        ],
        error: null,
      },
    );
    expect(snapshot.listeners).toEqual({ ok: true });
    expect(snapshot.sockets).toEqual([
      { pid: 220, port: 8000, address: "127.0.0.1" },
    ]);
    expect(
      attributeServers({
        table: snapshot.table,
        sockets: snapshot.sockets,
        daemonPid: 100,
        threadId: null,
      }),
    ).toMatchObject([
      { threadId: "thr_w", rootPid: 220, ports: [{ port: 8000 }] },
    ]);
  });

  it("explains why it cannot list listening ports, and keeps the threads", () => {
    const snapshot = buildWindowsSnapshot(AGENT_TREE, AGENT_ENVIRONMENTS, {
      listeners: null,
      error: "The term Get-NetTCPConnection is not recognized",
    });
    expect(snapshot.listeners).toEqual({
      ok: false,
      reason: expect.stringContaining("Get-NetTCPConnection"),
    });
    expect(snapshot.threads).toEqual({ ok: true });
  });

  it("lists listeners in the table script and parses them", () => {
    expect(WINDOWS_TABLE_SCRIPT).toContain(
      "Get-NetTCPConnection -State Listen",
    );
    expect(
      parseWindowsTable(
        JSON.stringify({
          processes: [],
          listeners: [{ pid: 1, port: 80, address: "::" }],
          listenersError: null,
        }),
      )?.listeners,
    ).toEqual([{ pid: 1, port: 80, address: "::" }]);
  });
});

describe("a parent link that points at a reused PID", () => {
  const EXPLORER_TREE: WindowsRow[] = [
    row(4, 0, "System"),
    row(100, 4, "node.exe"),
    row(110, 100, "node.exe"),
    row(200, 110, "claude.exe", { startedAt: T0 + 5_000 }),
    row(210, 200, "pwsh.exe", { startedAt: T0 + 6_000 }),
    row(300, 210, "npm.cmd", { startedAt: T0 + 9_000 }),
    row(500, 300, "explorer.exe", { startedAt: T0 + 1_000 }),
    row(510, 500, "notepad.exe", { startedAt: T0 + 2_000 }),
  ];
  const ENVIRONMENTS = environments([
    { pid: 100 },
    { pid: 110 },
    { pid: 200, threadId: "thr_w" },
    { pid: 210, threadId: "thr_w" },
    { pid: 300, threadId: "thr_w" },
    { pid: 500 },
    { pid: 510 },
  ]);

  it("drops the link when the parent started after the child", () => {
    const parents = dropStaleParents(EXPLORER_TREE);
    expect(parents.get(500)).toBe(0);
    expect(parents.get(510)).toBe(500);
    expect(parents.get(300)).toBe(210);
  });

  it("does not count explorer.exe, the way userinit's old PID is reused, in a thread's processes or Stop targets", () => {
    const snapshot = buildWindowsSnapshot(EXPLORER_TREE, ENVIRONMENTS);
    const result = attributeProcesses({
      table: snapshot.table,
      sockets: [],
      daemonPid: 100,
    });
    expect(result.processes.has(500)).toBe(false);
    expect(result.processes.has(510)).toBe(false);
    expect(descendants(snapshot.table, 300)).toEqual([300]);
    expect(result.roots.get(300)).toBe("thr_w");
  });

  it("keeps a link when either start time is unknown or the parent is older", () => {
    const parents = dropStaleParents([
      row(1, 0, "a", { startedAt: null }),
      row(2, 1, "b", { startedAt: T0 }),
      row(3, 2, "c", { startedAt: null }),
      row(4, 2, "d", { startedAt: T0 + 10 }),
    ]);
    expect([...parents]).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
  });
});

describe("Windows reader scripts", () => {
  it("lists processes with a script that compiles nothing, so a blocked reader still gives the table", () => {
    expect(WINDOWS_TABLE_SCRIPT).not.toMatch(
      /Add-Type|ReadProcessMemory|OpenProcess/,
    );
    expect(WINDOWS_TABLE_SCRIPT).toContain("Win32_Process");
  });

  it("compiles the environment reader once into a cached assembly named after its source", () => {
    const script = windowsEnvironmentScript({
      pids: [10, 20],
      cacheDir: "C:\\Users\\a'b\\bb-processes",
    });
    expect(script).toContain(`bb-process-environment-${readerHash()}.dll`);
    expect(script).toContain("-OutputAssembly");
    expect(script).toContain("Add-Type -Path $dll");
    expect(script).toContain("Test-Path -LiteralPath $dll");
    expect(script).toContain("'C:\\Users\\a''b\\bb-processes'");
    expect(script).toContain("@(10,20)");
    expect(readerHash()).toMatch(/^[0-9a-f]{12}$/);
  });

  it("only opens processes of the same user, read-only, and keeps nothing but the two ids", () => {
    const script = windowsEnvironmentScript({ pids: [], cacheDir: "C:\\c" });
    expect(script).toContain("OwnerOf(handle) != currentUser");
    expect(script).toContain("BB_THREAD_ID=");
    expect(script).toContain("CODEX_TOOL_CALL_ID=");
    expect(script).not.toMatch(
      /PROCESS_ALL_ACCESS|0x1FFFFF|WriteProcessMemory/,
    );
  });

  it("parses the table and the environments, and nothing malformed", () => {
    expect(
      parseWindowsTable(
        JSON.stringify({
          listeners: [],
          listenersError: null,
          processes: [
            {
              pid: 1,
              ppid: 0,
              name: "a.exe",
              command: null,
              cpuTimeMs: 1,
              rssBytes: 2,
              startToken: "t",
              startedAt: null,
            },
          ],
        }),
      )?.processes,
    ).toHaveLength(1);
    expect(parseWindowsTable("not json")).toBeNull();
    expect(parseWindowsTable('{"processes":[{"pid":"x"}]}')).toBeNull();
    expect(
      parseWindowsEnvironments(
        '{"blocked":null,"entries":[{"pid":4,"threadId":"thr","toolCallId":"","environment":"readable"}]}',
      )?.entries,
    ).toHaveLength(1);
    expect(parseWindowsEnvironments('{"blocked":null}')).toBeNull();
  });
});

describe("readWindowsSnapshot", () => {
  const tableJson = JSON.stringify({
    processes: AGENT_TREE.map((entry) => ({
      ...entry,
      command: entry.command,
    })),
    listeners: [],
    listenersError: null,
  });

  it("runs two PowerShell calls, the table first, with encoded scripts", async () => {
    const calls: Array<{ command: string; script: string }> = [];
    const snapshot = await readWindowsSnapshot(
      async (command, args) => {
        calls.push({
          command,
          script: Buffer.from(
            args[args.indexOf("-EncodedCommand") + 1]!,
            "base64",
          ).toString("utf16le"),
        });
        return calls.length === 1
          ? tableJson
          : JSON.stringify({
              blocked: null,
              entries: [
                {
                  pid: 220,
                  threadId: "thr_w",
                  toolCallId: "",
                  environment: "readable",
                },
              ],
            });
      },
      { cacheDir: "C:\\cache" },
    );
    expect(calls.map((call) => call.command)).toEqual([
      "powershell.exe",
      "powershell.exe",
    ]);
    expect(calls[0]!.script).toBe(WINDOWS_TABLE_SCRIPT);
    expect(calls[1]!.script).toContain("@(4,100,110,200,210,220)");
    expect(snapshot?.table.get(220)?.threadId).toBe("thr_w");
  });

  it("still gives the table, as top processes, when the environment script is blocked outright, and says so once", async () => {
    const reasons: string[] = [];
    let calls = 0;
    const snapshot = await readWindowsSnapshot(
      async () => (calls++ === 0 ? tableJson : null),
      { cacheDir: "C:\\cache", onBlocked: (reason) => reasons.push(reason) },
    );
    expect(snapshot?.table.size).toBe(0);
    expect(snapshot?.others).toHaveLength(AGENT_TREE.length);
    expect(snapshot?.threads).toEqual({
      ok: false,
      reason: expect.stringContaining("security software"),
    });
    expect(reasons).toHaveLength(1);
  });

  it("gives nothing when the process list itself cannot be read", async () => {
    await expect(
      readWindowsSnapshot(async () => null, { cacheDir: "C:\\cache" }),
    ).resolves.toBeNull();
    await expect(
      readWindowsSnapshot(async () => "garbage", { cacheDir: "C:\\cache" }),
    ).resolves.toBeNull();
  });
});
