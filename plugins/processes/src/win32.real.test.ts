import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRunTool } from "../host.js";
import { readWindowsSnapshot } from "./win32.js";

const exec = promisify(execFile);
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")(
  "the Windows environment reader on a real Windows machine",
  () => {
    it("reads BB_THREAD_ID and the start time of a child it started, and caches the compiled reader", async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 120000)"],
        {
          env: { ...process.env, BB_THREAD_ID: "thr_windows_real" },
          stdio: "ignore",
        },
      );
      children.push(child);
      const cacheDir = await mkdtemp(join(tmpdir(), "bb-processes-test-"));
      directories.push(cacheDir);
      const run = createRunTool((command, args, options) =>
        exec(command, [...args], options),
      );
      const reasons: string[] = [];
      const snapshot = await readWindowsSnapshot(run, {
        cacheDir,
        onBlocked: (reason) => reasons.push(reason),
      });
      expect(reasons).toEqual([]);
      expect(snapshot?.threads).toEqual({ ok: true });
      expect(snapshot?.table.get(child.pid!)?.threadId).toBe(
        "thr_windows_real",
      );
      expect(snapshot?.usage.get(child.pid!)?.startedAt).toBeGreaterThan(0);
      expect(snapshot?.usage.get(child.pid!)?.rssBytes).toBeGreaterThan(0);
      expect(snapshot?.table.get(process.pid)?.threadId ?? null).not.toBe(
        "thr_windows_real",
      );
      const again = await readWindowsSnapshot(run, { cacheDir });
      expect(again?.table.get(child.pid!)?.threadId).toBe("thr_windows_real");
    }, 120_000);
  },
);
