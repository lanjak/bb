import type { ExperimentalDiffLineAnnotation } from "@get-bb/plugin-sdk";
import type { GitComment } from "../../contract.js";

export const DRAFT_ANNOTATION_ID = "draft";

export function commentPath(comment: GitComment): string {
  return comment.currentPath ?? comment.path;
}

export function isOpenComment(comment: GitComment): boolean {
  return comment.state !== "resolved";
}

export function shownLines(comment: GitComment): {
  startLine: number;
  endLine: number;
} {
  const { placement } = comment;
  return placement.kind === "current" || placement.kind === "moved"
    ? { startLine: placement.startLine, endLine: placement.endLine }
    : { startLine: comment.startLine, endLine: comment.endLine };
}

export function formatLineRange(comment: GitComment): string {
  const { startLine, endLine } = shownLines(comment);
  const range =
    startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return comment.side === "old" ? `Removed L${range}` : `L${range}`;
}

export function placementLabel(comment: GitComment): string | null {
  const { placement } = comment;
  switch (placement.kind) {
    case "current":
      return null;
    case "moved":
      return `Moved from L${placement.fromStartLine}`;
    case "outdated":
      return "Outdated";
    case "not_in_diff":
      return "File no longer in this diff";
    case "unknown":
      return "Position unverified";
  }
}

export function isShownInline(comment: GitComment): boolean {
  const { kind } = comment.placement;
  if (comment.state === "resolved") {
    return kind === "current" || kind === "moved";
  }
  return kind !== "outdated" && kind !== "not_in_diff";
}

export function commentAnnotation(
  comment: GitComment,
): ExperimentalDiffLineAnnotation | null {
  if (!isShownInline(comment)) return null;
  return {
    id: comment.id,
    side: comment.side,
    line: shownLines(comment).endLine,
  };
}

export interface FileComments {
  path: string;
  comments: GitComment[];
}

export function groupCommentsByFile(
  comments: readonly GitComment[],
): FileComments[] {
  const groups = new Map<string, GitComment[]>();
  for (const comment of comments) {
    const path = commentPath(comment);
    groups.set(path, [...(groups.get(path) ?? []), comment]);
  }
  return [...groups]
    .map(([path, grouped]) => ({
      path,
      comments: [...grouped].sort(
        (first, second) =>
          shownLines(first).startLine - shownLines(second).startLine ||
          first.createdAt - second.createdAt,
      ),
    }))
    .sort((first, second) => first.path.localeCompare(second.path));
}

export function commentedPaths(
  comments: readonly GitComment[],
): ReadonlySet<string> {
  return new Set(
    comments.filter(isOpenComment).map((comment) => commentPath(comment)),
  );
}

export function formatCommentCount(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"}`;
}

export function formatSentTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function commentAuthorLabel(comment: GitComment): string {
  switch (comment.author.kind) {
    case "user":
      return "You";
    case "thread":
      return "Agent";
    case "unspecified":
      return "Unknown author";
  }
}
