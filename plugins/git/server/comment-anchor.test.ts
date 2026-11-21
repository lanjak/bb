import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceReads } from "../host/workspace-reads.js";
import {
  resolveCommentAnchor,
  splitFileLines,
  type CommentAnchor,
  type CommentPlacement,
} from "./comment-anchor.js";
import { blobsFromRevision } from "./comment-service.js";

const run = promisify(execFile);

const BASE = Array.from({ length: 30 }, (_, index) => `base line ${index + 1}`);
const FILE = "src/example.ts";

let repo = "";
let reads: WorkspaceReads;
let freshReads = 0;

async function git(...args: string[]) {
  await run("git", args, { cwd: repo });
}

async function writeFileLines(lines: readonly string[]) {
  await writeFile(join(repo, FILE), `${lines.join("\n")}\n`);
}

async function currentSide(): Promise<{
  blob: string;
  lines: string[];
}> {
  freshReads += 1;
  const result = await reads.diffFiles({
    freshness: { work: `work-${freshReads}`, refs: `refs-${freshReads}` },
    target: { type: "uncommitted" },
    maxFiles: 100,
    ignoreWhitespace: false,
  });
  const entry = result.files.find((file) => file.path === FILE);
  if (entry === undefined) throw new Error("file is not in the diff");
  const blob = blobsFromRevision(entry.revision).new;
  if (blob === null) throw new Error("no new blob");
  return {
    blob,
    lines: splitFileLines(await readFile(join(repo, FILE), "utf8")),
  };
}

async function commentOn(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): Promise<CommentAnchor> {
  await writeFileLines(lines);
  const { blob } = await currentSide();
  return {
    side: "new",
    startLine,
    endLine,
    lines: lines.slice(startLine - 1, endLine),
    contextBefore: lines.slice(Math.max(0, startLine - 4), startLine - 1),
    contextAfter: lines.slice(endLine, endLine + 3),
    blob,
  };
}

async function placementAfter(
  anchor: CommentAnchor,
  lines: readonly string[],
): Promise<CommentPlacement> {
  await writeFileLines(lines);
  return resolveCommentAnchor(anchor, await currentSide());
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "bb-comment-anchor-"));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await run("mkdir", ["-p", join(repo, "src")]);
  await writeFileLines(BASE);
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  reads = new WorkspaceReads(repo, tmpdir());
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function edited(overrides: Record<number, string>): string[] {
  return BASE.map((line, index) => overrides[index + 1] ?? line);
}

describe("resolveCommentAnchor against real git revisions", () => {
  it("keeps the line when the file blob is unchanged, without reading content", async () => {
    const version = edited({ 10: "const ttl = 60;", 11: "const max = 5;" });
    const anchor = await commentOn(version, 10, 11);
    const { blob } = await currentSide();
    expect(resolveCommentAnchor(anchor, { blob, lines: null })).toEqual({
      kind: "current",
      startLine: 10,
      endLine: 11,
    });
  });

  it("reports moved with the new lines when lines are inserted above", async () => {
    const version = edited({ 10: "const ttl = 60;", 11: "const max = 5;" });
    const anchor = await commentOn(version, 10, 11);
    const withInsertion = [
      ...version.slice(0, 3),
      "inserted a",
      "inserted b",
      "inserted c",
      ...version.slice(3),
    ];
    expect(await placementAfter(anchor, withInsertion)).toEqual({
      kind: "moved",
      startLine: 13,
      endLine: 14,
      fromStartLine: 10,
    });
  });

  it("stays current when the file changed elsewhere but the code is still there", async () => {
    const version = edited({ 10: "const ttl = 60;" });
    const anchor = await commentOn(version, 10, 10);
    const changedElsewhere = version.map((line, index) =>
      index + 1 === 25 ? "unrelated edit" : line,
    );
    expect(await placementAfter(anchor, changedElsewhere)).toEqual({
      kind: "current",
      startLine: 10,
      endLine: 10,
    });
  });

  it("reports outdated when the commented line is edited", async () => {
    const version = edited({ 10: "const ttl = 60;" });
    const anchor = await commentOn(version, 10, 10);
    expect(
      await placementAfter(anchor, edited({ 10: "const ttl = 120;" })),
    ).toEqual({ kind: "outdated" });
  });

  it("reports outdated when the commented code is deleted", async () => {
    const version = edited({ 10: "const ttl = 60;", 11: "const max = 5;" });
    const anchor = await commentOn(version, 10, 11);
    const without = version.filter(
      (_, index) => index + 1 !== 10 && index + 1 !== 11,
    );
    expect(await placementAfter(anchor, without)).toEqual({ kind: "outdated" });
  });

  it("ignores trailing whitespace and CRLF when matching", async () => {
    const version = edited({ 10: "const ttl = 60;" });
    const anchor = await commentOn(version, 10, 10);
    const crlf = version.map((line, index) =>
      index + 1 === 10 ? "const ttl = 60;   \r" : line,
    );
    expect(
      resolveCommentAnchor(anchor, {
        blob: "different",
        lines: crlf,
      }),
    ).toEqual({ kind: "current", startLine: 10, endLine: 10 });
  });

  it("picks the duplicate whose surrounding lines still match", async () => {
    const version = edited({ 10: "return cache.get(key);" });
    const anchor = await commentOn(version, 10, 10);
    const withDuplicateAbove = [
      "return cache.get(key);",
      ...version.slice(0, 20),
      "return cache.get(key);",
      ...version.slice(20),
    ];
    expect(await placementAfter(anchor, withDuplicateAbove)).toEqual({
      kind: "moved",
      startLine: 11,
      endLine: 11,
      fromStartLine: 10,
    });
  });

  it("breaks a tie between identical duplicates by distance from the original line", async () => {
    const block = ["}", "}"];
    const lines = [...BASE.slice(0, 9), ...block, ...BASE.slice(9)];
    const anchor = await commentOn(lines, 10, 11);
    const mixed = lines.map((line, index) =>
      index + 1 === 1 || index + 1 === 2 ? "}" : line,
    );
    const placement = resolveCommentAnchor(
      { ...anchor, contextBefore: [], contextAfter: [] },
      { blob: "changed", lines: mixed },
    );
    expect(placement).toEqual({ kind: "current", startLine: 10, endLine: 11 });
  });

  it("keeps the same blob when the file is renamed without edits", async () => {
    const version = edited({ 10: "const ttl = 60;" });
    const anchor = await commentOn(version, 10, 10);
    await git("mv", FILE, "src/renamed.ts");
    freshReads += 1;
    const result = await reads.diffFiles({
      freshness: { work: `work-${freshReads}`, refs: `refs-${freshReads}` },
      target: { type: "uncommitted" },
      maxFiles: 100,
      ignoreWhitespace: false,
    });
    const renamed = result.files.find((file) => file.path === "src/renamed.ts");
    expect(renamed?.previousPath).toBe(FILE);
    const blob = blobsFromRevision(renamed?.revision ?? "").new;
    expect(blob).toBe(anchor.blob);
    expect(
      resolveCommentAnchor(anchor, { blob: blob ?? "", lines: null }),
    ).toEqual({ kind: "current", startLine: 10, endLine: 10 });
  });

  it("reports not_in_diff when the file left the diff, and unknown when it cannot be read", async () => {
    const version = edited({ 10: "const ttl = 60;" });
    const anchor = await commentOn(version, 10, 10);
    expect(resolveCommentAnchor(anchor, null)).toEqual({ kind: "not_in_diff" });
    expect(
      resolveCommentAnchor(anchor, { blob: "other", lines: null }),
    ).toEqual({ kind: "unknown" });
  });
});
