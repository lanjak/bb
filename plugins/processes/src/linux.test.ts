import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeProcAddress,
  environHidden,
  parseProcNetTcp,
  parseBootTime,
  parseProcStat,
  readLinuxClock,
  readLinuxSnapshot,
  threadIdFromEnviron,
} from "./linux.js";

const UID = process.getuid?.() ?? 1000;
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function tcpLine(
  local: string,
  state: string,
  uid: number,
  inode: number,
): string {
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
}

function statLine(entry: {
  pid: number;
  ppid: number;
  comm: string;
  cpuTicks?: number;
  startTicks?: number;
  rssPages?: number;
}): string {
  const fields = Array.from({ length: 49 }, () => 0);
  fields[0] = entry.pid;
  fields[3] = entry.ppid;
  fields[13] = Math.floor((entry.cpuTicks ?? 0) / 2);
  fields[14] = Math.ceil((entry.cpuTicks ?? 0) / 2);
  fields[21] = entry.startTicks ?? 100;
  fields[23] = entry.rssPages ?? 0;
  return `${entry.pid} (${entry.comm} (x)) S ${fields.slice(3).join(" ")}\n`;
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fakeProc(
  processes: Array<{
    pid: number;
    ppid: number;
    comm: string;
    environ: string[];
    cmdline?: string[];
    sockets?: number[];
    cpuTicks?: number;
    startTicks?: number;
    rssPages?: number;
  }>,
  tcp: string,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "processes-proc-"));
  roots.push(root);
  await mkdir(path.join(root, "net"));
  await writeFile(path.join(root, "net", "tcp"), HEADER + tcp);
  for (const entry of processes) {
    const directory = path.join(root, String(entry.pid));
    await mkdir(path.join(directory, "fd"), { recursive: true });
    await writeFile(path.join(directory, "stat"), statLine(entry));
    await writeFile(path.join(directory, "comm"), `${entry.comm}\n`);
    await writeFile(
      path.join(directory, "cmdline"),
      (entry.cmdline ?? [entry.comm]).map((arg) => `${arg}\0`).join(""),
    );
    await writeFile(
      path.join(directory, "environ"),
      entry.environ.map((value) => `${value}\0`).join(""),
    );
    for (const [index, inode] of (entry.sockets ?? []).entries())
      await symlink(
        `socket:[${inode}]`,
        path.join(directory, "fd", String(index + 3)),
      );
  }
  return root;
}

describe("Linux /proc parsing", () => {
  it("decodes IPv4 and IPv6 socket addresses", () => {
    expect(decodeProcAddress("0100007F")).toBe("127.0.0.1");
    expect(decodeProcAddress("00000000")).toBe("0.0.0.0");
    expect(decodeProcAddress("00000000000000000000000001000000")).toBe("::1");
    expect(decodeProcAddress("00000000000000000000000000000000")).toBe("::");
    expect(decodeProcAddress("0000000000000000FFFF00000100007F")).toBe(
      "::ffff:127.0.0.1",
    );
  });

  it("keeps only listening sockets of the user", () => {
    const listening = parseProcNetTcp(
      HEADER +
        tcpLine("0100007F:1435", "0A", UID, 11) +
        tcpLine("0100007F:1436", "01", UID, 12) +
        tcpLine("0100007F:1437", "0A", UID + 1, 13),
      UID,
    );
    expect([...listening]).toEqual([
      ["11", { port: 5173, address: "127.0.0.1" }],
    ]);
  });

  it("reads the parent, CPU ticks, start and pages from a stat line whose name holds a parenthesis", () => {
    expect(
      parseProcStat(
        statLine({
          pid: 42,
          ppid: 7,
          comm: "node (vite)",
          cpuTicks: 250,
          startTicks: 9000,
          rssPages: 300,
        }),
      ),
    ).toEqual({
      ppid: 7,
      cpuTicks: 250,
      startTicks: 9000,
      rssPages: 300,
    });
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("reads the boot time and the clock of the machine", async () => {
    expect(parseBootTime("cpu 1 2 3\nbtime 1700000000\nprocesses 5\n")).toBe(
      1_700_000_000_000,
    );
    expect(parseBootTime("cpu 1 2 3\n")).toBeNull();
    const root = await fakeProc([], "");
    await writeFile(path.join(root, "stat"), "btime 1700000000\n");
    await expect(
      readLinuxClock(
        async (_command, args) => (args[0] === "PAGESIZE" ? "16384\n" : null),
        root,
      ),
    ).resolves.toEqual({
      pageSize: 16384,
      clockTicks: 100,
      bootTimeMs: 1_700_000_000_000,
    });
  });

  it("treats an environment without variables as hidden", () => {
    expect(environHidden("npm run dev\0\0")).toBe(true);
    expect(environHidden(null)).toBe(true);
    expect(environHidden("A=1\0")).toBe(false);
  });

  it("reads the thread id from the environment", () => {
    expect(threadIdFromEnviron("A=1\0BB_THREAD_ID=thr_x\0B=2\0")).toBe("thr_x");
    expect(threadIdFromEnviron("BB_THREAD_ID=\0")).toBeNull();
    expect(threadIdFromEnviron("A=1\0")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "maps listening sockets to processes of a thread",
    async () => {
      const root = await fakeProc(
        [
          { pid: 10, ppid: 1, comm: "zsh", environ: ["BB_THREAD_ID=thr_a"] },
          {
            pid: 11,
            ppid: 10,
            comm: "node",
            environ: ["BB_THREAD_ID=thr_a"],
            sockets: [501, 502],
            cpuTicks: 250,
            rssPages: 300,
          },
          { pid: 12, ppid: 1, comm: "postgres", environ: [], sockets: [503] },
          {
            pid: 13,
            ppid: 1,
            comm: "node",
            environ: ["BB_THREAD_ID=thr_a"],
            cmdline: ["node", "/usr/lib/node_modules/npm/bin/npx-cli.js", "x"],
          },
        ],
        tcpLine("0100007F:1435", "0A", UID, 501) +
          tcpLine("0100007F:1436", "01", UID, 502) +
          tcpLine("00000000:1538", "0A", UID, 503),
      );
      const snapshot = await readLinuxSnapshot(UID, root, {
        pageSize: 4096,
        clockTicks: 100,
        bootTimeMs: 1_700_000_000_000,
      });
      expect(snapshot.table.get(11)).toEqual({
        pid: 11,
        ppid: 10,
        name: "node",
        threadId: "thr_a",
        toolCallId: null,
        launcher: false,
      });
      expect(snapshot.table.get(13)?.launcher).toBe(true);
      expect(snapshot.usage.get(11)).toEqual({
        startToken: "100",
        startedAt: 1_700_000_001_000,
        cpuTimeMs: 2500,
        rssBytes: 300 * 4096,
        command: "node",
      });
      expect(snapshot.sockets).toEqual([
        { pid: 11, port: 5173, address: "127.0.0.1" },
      ]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reads CPU time, memory and start of real processes, and lists other users' processes apart",
    async () => {
      const clock = await readLinuxClock(async () => null);
      const snapshot = await readLinuxSnapshot(UID, "/proc", clock);
      const self = snapshot.usage.get(process.pid);
      expect(self?.rssBytes).toBeGreaterThan(1_000_000);
      expect(self?.cpuTimeMs).toBeGreaterThan(0);
      expect(self?.startToken).toMatch(/^\d+$/);
      expect(snapshot.table.has(process.pid)).toBe(true);
      expect(snapshot.others.some((other) => other.pid === process.pid)).toBe(
        false,
      );
      if (UID !== 0) expect(snapshot.others.length).toBeGreaterThan(0);
    },
  );
});
