export interface CommentAnchor {
  side: "new" | "old";
  startLine: number;
  endLine: number;
  lines: readonly string[];
  contextBefore: readonly string[];
  contextAfter: readonly string[];
  blob: string;
}

export interface CurrentFileSide {
  blob: string;
  lines: readonly string[] | null;
}

export type CommentPlacement =
  | { kind: "current"; startLine: number; endLine: number }
  | {
      kind: "moved";
      startLine: number;
      endLine: number;
      fromStartLine: number;
    }
  | { kind: "outdated" }
  | { kind: "not_in_diff" }
  | { kind: "unknown" };

const CONTEXT_MATCH_WEIGHT = 1_000_000;

function normalizeLine(line: string): string {
  return line.replace(/\s+$/u, "");
}

export function splitFileLines(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function matchesAt(
  file: readonly string[],
  needle: readonly string[],
  index: number,
): boolean {
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (file[index + offset] !== needle[offset]) return false;
  }
  return true;
}

function contextScore(
  file: readonly string[],
  anchor: CommentAnchor,
  index: number,
): number {
  let score = 0;
  const before = anchor.contextBefore;
  for (let offset = 1; offset <= before.length; offset += 1) {
    const stored = before[before.length - offset];
    if (stored !== undefined && file[index - offset] === stored) score += 1;
    else break;
  }
  const after = anchor.contextAfter;
  const afterStart = index + anchor.lines.length;
  for (let offset = 0; offset < after.length; offset += 1) {
    if (file[afterStart + offset] === after[offset]) score += 1;
    else break;
  }
  return score;
}

export function resolveCommentAnchor(
  anchor: CommentAnchor,
  current: CurrentFileSide | null,
): CommentPlacement {
  if (current === null) return { kind: "not_in_diff" };
  if (anchor.blob.length > 0 && current.blob === anchor.blob) {
    return {
      kind: "current",
      startLine: anchor.startLine,
      endLine: anchor.endLine,
    };
  }
  if (current.lines === null) return { kind: "unknown" };
  const file = current.lines.map(normalizeLine);
  const needle = anchor.lines.map(normalizeLine);
  const normalizedAnchor: CommentAnchor = {
    ...anchor,
    lines: needle,
    contextBefore: anchor.contextBefore.map(normalizeLine),
    contextAfter: anchor.contextAfter.map(normalizeLine),
  };
  let best: { index: number; rank: number } | null = null;
  for (let index = 0; index + needle.length <= file.length; index += 1) {
    if (!matchesAt(file, needle, index)) continue;
    const distance = Math.abs(index + 1 - anchor.startLine);
    const rank =
      contextScore(file, normalizedAnchor, index) * CONTEXT_MATCH_WEIGHT -
      distance;
    if (best === null || rank > best.rank) best = { index, rank };
  }
  if (best === null) return { kind: "outdated" };
  const startLine = best.index + 1;
  const endLine = startLine + needle.length - 1;
  return startLine === anchor.startLine
    ? { kind: "current", startLine, endLine }
    : {
        kind: "moved",
        startLine,
        endLine,
        fromStartLine: anchor.startLine,
      };
}
