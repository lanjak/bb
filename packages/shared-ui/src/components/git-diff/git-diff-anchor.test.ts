import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectedLineRange } from "@pierre/diffs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGitDiffFiles, type ParsedGitDiffFile } from "./git-diff-parsing";
import { diffSelectionToAnchor } from "./git-diff-patch-text";

const BEFORE = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
const AFTER = [
  "line 1",
  "line 2",
  "line 3",
  "line 4",
  "changed 5",
  "changed 6",
  "extra 6b",
  "line 7",
  "line 8",
  "line 10",
  "line 11",
  "line 12",
  "line 13",
  "line 14",
];

const WIDE_BEFORE = Array.from({ length: 40 }, (_, index) => `g ${index + 1}`);
const WIDE_AFTER = [
  "top a",
  "top b",
  ...WIDE_BEFORE.slice(0, 19),
  "g 20 changed",
  ...WIDE_BEFORE.slice(20, 22),
  ...WIDE_BEFORE.slice(23, 35),
  "g 36 changed",
  ...WIDE_BEFORE.slice(36),
];
const LONG = Array.from({ length: 60 }, (_, index) => `long ${index + 1}`);

let workDir = "";
let fileDiff: ParsedGitDiffFile;
let wideDiff: ParsedGitDiffFile;
let longDiff: ParsedGitDiffFile;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: workDir, encoding: "utf8" });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "bb-anchor-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(workDir, "f.txt"), `${BEFORE.join("\n")}\n`);
  writeFileSync(join(workDir, "wide.txt"), `${WIDE_BEFORE.join("\n")}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(workDir, "f.txt"), `${AFTER.join("\n")}\n`);
  writeFileSync(join(workDir, "wide.txt"), `${WIDE_AFTER.join("\n")}\n`);
  writeFileSync(join(workDir, "long.txt"), `${LONG.join("\n")}\n`);
  git("add", "-N", "long.txt");
  const parsed = parseGitDiffFiles(git("diff", "--no-color", "-U3", "f.txt"))[0];
  const wide = parseGitDiffFiles(git("diff", "--no-color", "-U3", "wide.txt"))[0];
  const long = parseGitDiffFiles(git("diff", "--no-color", "-U3", "long.txt"))[0];
  if (parsed === undefined || wide === undefined || long === undefined) {
    throw new Error("no parsed diff");
  }
  fileDiff = parsed;
  wideDiff = wide;
  longDiff = long;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function withoutSelectedRows(
  value: ReturnType<typeof diffSelectionToAnchor>,
): object | null {
  if (value === null) return null;
  const { selectedFrom: _from, selectedTo: _to, ...rest } = value;
  return rest;
}

function anchor(displayStyle: "unified" | "split", range: SelectedLineRange) {
  return diffSelectionToAnchor({ displayStyle, fileDiff, range });
}

describe("diffSelectionToAnchor against a real git patch", () => {
  it("uses the new line number for a context row in both views", () => {
    const unified = anchor("unified", {
      start: 3,
      end: 3,
      side: "additions",
    });
    const splitLeft = anchor("split", {
      start: 3,
      end: 3,
      side: "deletions",
      endSide: "deletions",
    });
    expect(unified).toMatchObject({
      side: "new",
      startLine: 3,
      endLine: 3,
      lines: ["line 3"],
      contextBefore: ["line 2"],
      contextAfter: ["line 4", "changed 5", "changed 6"],
      truncated: false,
    });
    expect(withoutSelectedRows(splitLeft)).toEqual(
      withoutSelectedRows(unified),
    );
  });

  it("anchors a modified row to the paired new line, not the removed one", () => {
    const unified = anchor("unified", {
      start: 5,
      end: 5,
      side: "deletions",
    });
    const split = anchor("split", {
      start: 5,
      end: 5,
      side: "deletions",
      endSide: "deletions",
    });
    expect(unified).toMatchObject({
      side: "new",
      startLine: 5,
      endLine: 5,
      lines: ["changed 5"],
    });
    expect(withoutSelectedRows(split)).toEqual(withoutSelectedRows(unified));
  });

  it("pairs the Nth deletion with the Nth addition of a change block", () => {
    expect(
      anchor("unified", { start: 6, end: 6, side: "deletions" }),
    ).toMatchObject({ side: "new", startLine: 6, lines: ["changed 6"] });
  });

  it("anchors an addition with no paired deletion to its new line", () => {
    expect(
      anchor("unified", { start: 7, end: 7, side: "additions" }),
    ).toMatchObject({ side: "new", startLine: 7, lines: ["extra 6b"] });
  });

  it("keeps a genuinely removed line on the old side", () => {
    expect(anchor("unified", { start: 9, end: 9, side: "deletions" })).toMatchObject({
      side: "old",
      startLine: 9,
      endLine: 9,
      lines: ["line 9"],
      contextBefore: ["line 6", "line 7", "line 8"],
      contextAfter: ["line 10", "line 11", "line 12"],
    });
  });

  it("covers the new lines of a mixed range and ignores the removed ones", () => {
    const unified = anchor("unified", {
      start: 4,
      end: 8,
      side: "additions",
      endSide: "additions",
    });
    expect(unified).toMatchObject({
      side: "new",
      startLine: 4,
      endLine: 8,
      lines: ["line 4", "changed 5", "changed 6", "extra 6b", "line 7"],
    });
  });

  it("limits context at hunk edges", () => {
    expect(
      anchor("unified", { start: 2, end: 2, side: "additions" }),
    ).toMatchObject({
      contextBefore: [],
      contextAfter: ["line 3", "line 4", "changed 5"],
    });
  });

  it("returns null when the range is not in the patch", () => {
    expect(anchor("unified", { start: 500, end: 500, side: "additions" })).toBe(
      null,
    );
  });
});

describe("diffSelectionToAnchor where old and new numbers differ", () => {
  const anchorIn = (
    diff: ParsedGitDiffFile,
    displayStyle: "unified" | "split",
    range: SelectedLineRange,
  ) => diffSelectionToAnchor({ displayStyle, fileDiff: diff, range });

  it("uses the new number for a context row clicked in unified and in split-left", () => {
    const unified = anchorIn(wideDiff, "unified", {
      start: 19,
      end: 19,
      side: "additions",
    });
    const splitLeft = anchorIn(wideDiff, "split", {
      start: 17,
      end: 17,
      side: "deletions",
      endSide: "deletions",
    });
    expect(unified).toMatchObject({
      side: "new",
      startLine: 19,
      endLine: 19,
      lines: ["g 17"],
    });
    expect(withoutSelectedRows(splitLeft)).toEqual(withoutSelectedRows(unified));
    expect(splitLeft?.selectedFrom).toEqual({ side: "old", line: 17 });
    expect(unified?.selectedFrom).toEqual({ side: "new", line: 19 });
  });

  it("anchors the removed half of a modified row to its new line and keeps the clicked row", () => {
    const anchored = anchorIn(wideDiff, "unified", {
      start: 20,
      end: 20,
      side: "deletions",
    });
    expect(anchored).toMatchObject({
      side: "new",
      startLine: 22,
      endLine: 22,
      lines: ["g 20 changed"],
      selectedFrom: { side: "old", line: 20 },
      selectedTo: { side: "old", line: 20 },
    });
  });

  it("covers the new lines across both change blocks of a hunk and drops the removed row", () => {
    const across = anchorIn(wideDiff, "unified", {
      start: 22,
      end: 24,
      side: "additions",
      endSide: "additions",
    });
    expect(across).toMatchObject({
      side: "new",
      startLine: 22,
      endLine: 24,
      lines: ["g 20 changed", "g 21", "g 22"],
      truncated: false,
    });
  });

  it("marks a range that crosses hunks as truncated at the hunk edge", () => {
    const crossing = anchorIn(wideDiff, "unified", {
      start: 22,
      end: 38,
      side: "additions",
      endSide: "additions",
    });
    expect(crossing).not.toBeNull();
    expect(crossing?.truncated).toBe(true);
    expect(crossing?.startLine).toBe(22);
    expect(crossing?.endLine).toBeLessThan(38);
  });

  it("marks a selection of more than 50 lines as truncated at 50", () => {
    const long = anchorIn(longDiff, "unified", {
      start: 1,
      end: 60,
      side: "additions",
      endSide: "additions",
    });
    expect(long).toMatchObject({
      startLine: 1,
      endLine: 50,
      truncated: true,
    });
    expect(long?.lines).toHaveLength(50);
    const within = anchorIn(longDiff, "unified", {
      start: 1,
      end: 50,
      side: "additions",
      endSide: "additions",
    });
    expect(within?.truncated).toBe(false);
  });
});
