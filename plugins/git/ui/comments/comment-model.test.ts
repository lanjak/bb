import { describe, expect, it } from "vitest";
import type { GitComment } from "../../contract.js";
import {
  commentAnnotation,
  commentAuthorLabel,
  commentedPaths,
  formatSentTime,
  formatLineRange,
  groupCommentsByFile,
  isShownInline,
  placementLabel,
  shownLines,
} from "./comment-model.js";

function makeComment(overrides: Partial<GitComment> = {}): GitComment {
  return {
    id: "dcm_0000000000000001",
    environmentId: "env-1",
    path: "src/a.ts",
    side: "new",
    startLine: 10,
    endLine: 12,
    lines: ["a", "b", "c"],
    contextBefore: [],
    contextAfter: [],
    body: "Why?",
    author: { kind: "user" },
    state: "unsent",
    placement: { kind: "current", startLine: 10, endLine: 12 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("comment model", () => {
  it("places a comment under the last line it covers now", () => {
    expect(commentAnnotation(makeComment())).toEqual({
      id: "dcm_0000000000000001",
      side: "new",
      line: 12,
    });
    const moved = makeComment({
      placement: {
        kind: "moved",
        startLine: 20,
        endLine: 22,
        fromStartLine: 10,
      },
    });
    expect(commentAnnotation(moved)).toMatchObject({ line: 22 });
    expect(shownLines(moved)).toEqual({ startLine: 20, endLine: 22 });
    expect(formatLineRange(moved)).toBe("L20-22");
    expect(placementLabel(moved)).toBe("Moved from L10");
  });

  it("keeps outdated and out-of-diff comments out of the diff, and unverified ones at their stored lines", () => {
    const outdated = makeComment({ placement: { kind: "outdated" } });
    const gone = makeComment({ placement: { kind: "not_in_diff" } });
    const unknown = makeComment({ placement: { kind: "unknown" } });
    expect(isShownInline(outdated)).toBe(false);
    expect(commentAnnotation(outdated)).toBeNull();
    expect(commentAnnotation(gone)).toBeNull();
    expect(commentAnnotation(unknown)).toMatchObject({ line: 12 });
    expect(placementLabel(outdated)).toBe("Outdated");
    expect(placementLabel(gone)).toBe("File no longer in this diff");
    expect(placementLabel(unknown)).toBe("Position unverified");
    expect(placementLabel(makeComment())).toBeNull();
  });

  it("shows a resolved comment inline only where its code still is", () => {
    const resolved = (placement: GitComment["placement"]) =>
      makeComment({ state: "resolved", placement });
    expect(
      isShownInline(resolved({ kind: "current", startLine: 10, endLine: 12 })),
    ).toBe(true);
    expect(isShownInline(resolved({ kind: "unknown" }))).toBe(false);
    expect(isShownInline(resolved({ kind: "outdated" }))).toBe(false);
    expect(isShownInline(makeComment({ placement: { kind: "unknown" } }))).toBe(
      true,
    );
  });

  it("names comments whose author was not stated", () => {
    expect(commentAuthorLabel(makeComment())).toBe("You");
    expect(
      commentAuthorLabel(
        makeComment({ author: { kind: "thread", threadId: "t" } }),
      ),
    ).toBe("Agent");
    expect(
      commentAuthorLabel(makeComment({ author: { kind: "unspecified" } })),
    ).toBe("Unknown author");
  });

  it("labels removed-code comments and single lines", () => {
    const removed = makeComment({
      side: "old",
      startLine: 5,
      endLine: 5,
      placement: { kind: "current", startLine: 5, endLine: 5 },
    });
    expect(formatLineRange(removed)).toBe("Removed L5");
    expect(commentAnnotation(removed)).toEqual({
      id: removed.id,
      side: "old",
      line: 5,
    });
  });

  it("groups by current file and orders by line", () => {
    const groups = groupCommentsByFile([
      makeComment({
        id: "dcm_0000000000000002",
        path: "src/z.ts",
        placement: { kind: "current", startLine: 3, endLine: 3 },
      }),
      makeComment({
        id: "dcm_0000000000000003",
        placement: { kind: "current", startLine: 40, endLine: 40 },
      }),
      makeComment({
        id: "dcm_0000000000000004",
        path: "src/old-name.ts",
        currentPath: "src/a.ts",
        placement: { kind: "current", startLine: 7, endLine: 7 },
      }),
    ]);
    expect(groups.map((group) => group.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(groups[0]?.comments.map((comment) => comment.id)).toEqual([
      "dcm_0000000000000004",
      "dcm_0000000000000003",
    ]);
  });

  it("counts only open comments when listing commented files", () => {
    expect(
      commentedPaths([
        makeComment(),
        makeComment({ path: "src/done.ts", state: "resolved" }),
      ]),
    ).toEqual(new Set(["src/a.ts"]));
  });

  it("formats the time a comment was sent", () => {
    const at = new Date(2026, 10, 21, 15, 45).getTime();
    expect(formatSentTime(at)).toMatch(/45/u);
  });
});
