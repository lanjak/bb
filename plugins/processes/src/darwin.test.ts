import { describe, expect, it } from "vitest";
import {
  normalizeLstart,
  parseLsofListeners,
  parsePsCpuTime,
  parsePsEnvironment,
  parsePsTable,
  readDarwinSnapshot,
} from "./darwin.js";

const STARTED = "Mon Nov 24 08:29:04 2026";

function psLine(
  pid: number,
  ppid: number,
  uid: number,
  comm: string,
  options: { rssKb?: number; time?: string; started?: string } = {},
): string {
  return `  ${pid}  ${ppid}  ${uid}  ${options.rssKb ?? 1024}  ${options.time ?? "0:01.50"} ${options.started ?? STARTED} ${comm}\n`;
}

describe("macOS process parsing", () => {
  it("reads pid, parent, memory, CPU time and start of every process", () => {
    const rows = parsePsTable(
      psLine(501, 1, 501, "/bin/zsh", { rssKb: 2048, time: "1:02:03.50" }) +
        psLine(777, 501, 501, "/usr/local/bin/node") +
        psLine(900, 1, 0, "/usr/sbin/sshd", {
          started: "Tue Nov  3 01:02:03 2026",
        }),
    );
    expect(rows.map((row) => [row.pid, row.ppid, row.uid, row.name])).toEqual([
      [501, 1, 501, "zsh"],
      [777, 501, 501, "node"],
      [900, 1, 0, "sshd"],
    ]);
    expect(rows[0]).toMatchObject({
      rssBytes: 2048 * 1024,
      cpuTimeMs: 3_723_500,
      startToken: STARTED,
    });
    expect(rows[2]!.startToken).toBe("Tue Nov 3 01:02:03 2026");
    expect(rows[0]!.startedAt).toBe(Date.parse(STARTED));
  });

  it("reads ps output in the day-first order of en_AU and en_GB, to the same start token", () => {
    const rows = parsePsTable(
      psLine(501, 1, 501, "/bin/zsh", { started: "Mon 24 Nov 08:29:04 2026" }) +
        psLine(502, 1, 501, "/bin/sh", { started: "Mon  3 Nov 01:02:03 2026" }),
    );
    expect(rows.map((row) => row.startToken)).toEqual([
      STARTED,
      "Mon Nov 3 01:02:03 2026",
    ]);
    expect(rows[0]!.startedAt).toBe(Date.parse(STARTED));
    expect(normalizeLstart("Tue 25 Nov 10:00:00 2026")).toBe(
      "Tue Nov 25 10:00:00 2026",
    );
  });

  it("reads cumulative CPU time in each ps format", () => {
    expect(parsePsCpuTime("0:00.03")).toBe(30);
    expect(parsePsCpuTime("147:30.12")).toBe(8_850_120);
    expect(parsePsCpuTime("1:23:45.67")).toBe(5_025_670);
    expect(parsePsCpuTime("2-03:04:05.00")).toBe(183_845_000);
    expect(parsePsCpuTime("nonsense")).toBeNull();
  });

  it("takes the thread id from the environment after the arguments", () => {
    const threads = parsePsEnvironment(
      [
        "  777 node server.js --label BB_THREAD_ID=fake",
        "  778 node other.js",
        "  779 npm run serve",
      ].join("\n"),
      [
        "  777 node server.js --label BB_THREAD_ID=fake PATH=/bin BB_THREAD_ID=thr_real CODEX_TOOL_CALL_ID=exec-9",
        "  778 node other.js PATH=/bin",
        "  779 npm run serve   ",
      ].join("\n"),
    );
    expect([...threads]).toEqual([
      [
        777,
        {
          threadId: "thr_real",
          toolCallId: "exec-9",
          argv: ["node", "server.js"],
          command: "node server.js --label BB_THREAD_ID=fake",
          hidden: false,
        },
      ],
      [
        778,
        {
          threadId: null,
          toolCallId: null,
          argv: ["node", "other.js"],
          command: "node other.js",
          hidden: false,
        },
      ],
      [
        779,
        {
          threadId: null,
          toolCallId: null,
          argv: ["npm", "run"],
          command: "npm run serve",
          hidden: true,
        },
      ],
    ]);
  });

  it("gives a process that hides its environment the thread of its parent", async () => {
    const outputs: Record<string, string> = {
      "-axo":
        psLine(10, 1, 501, "/bin/zsh") +
        psLine(11, 10, 501, "npm run serve") +
        psLine(12, 11, 501, "/usr/bin/python3") +
        psLine(40, 1, 0, "/usr/sbin/sshd", { rssKb: 5000 }),
      "-axww":
        "  10 /bin/zsh -c npm run serve\n  11 npm run serve\n  12 python3 -m http.server\n",
      "-axwwE":
        "  10 /bin/zsh -c npm run serve BB_THREAD_ID=thr_mac\n  11 npm run serve\n  12 python3 -m http.server BB_THREAD_ID=thr_mac\n",
    };
    const snapshot = await readDarwinSnapshot(501, async (command, args) =>
      command === "/usr/sbin/lsof"
        ? "p12\nn127.0.0.1:8000\n"
        : outputs[args[0]!]!,
    );
    expect(snapshot?.table.get(11)).toMatchObject({
      threadId: "thr_mac",
      launcher: true,
    });
    expect(snapshot?.usage.get(12)).toEqual({
      startToken: STARTED,
      startedAt: Date.parse(STARTED),
      cpuTimeMs: 1500,
      rssBytes: 1024 * 1024,
      command: "python3 -m http.server",
    });
    expect(snapshot?.others).toEqual([
      {
        pid: 40,
        name: "sshd",
        startToken: STARTED,
        cpuTimeMs: 1500,
        rssBytes: 5000 * 1024,
      },
    ]);
    expect(snapshot?.table.has(40)).toBe(false);
  });

  it("treats a process missing from one ps run as hidden", () => {
    const entries = parsePsEnvironment(
      "  10 node a.js\n",
      "  10 node a.js BB_THREAD_ID=thr_x\n  11 node b.js BB_THREAD_ID=thr_x\n",
    );
    expect(entries.get(10)).toMatchObject({ threadId: "thr_x", hidden: false });
    expect(entries.get(11)?.hidden).toBe(true);
  });

  it("reads listening ports for each process", () => {
    expect(
      parseLsofListeners(
        "p777\nf20\nn127.0.0.1:5173\nf21\nn[::1]:5173\np800\nf5\nn*:3000\n",
      ),
    ).toEqual([
      { pid: 777, port: 5173, address: "127.0.0.1" },
      { pid: 777, port: 5173, address: "::1" },
      { pid: 800, port: 3000, address: "0.0.0.0" },
    ]);
  });

  it("gives no snapshot when a tool fails", async () => {
    await expect(
      readDarwinSnapshot(501, async (command) =>
        command === "/usr/sbin/lsof" ? null : "",
      ),
    ).resolves.toBeNull();
  });
});
