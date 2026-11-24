import { EVENT_PATH_PATTERN, EVENT_WHERE_CLAUSES_MAX } from "./limits.js";
import {
  eventWhereOpSchema,
  type AutomationEventTrigger,
  type EventWhere,
} from "./rpc-types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPath(
  node: unknown,
  segments: readonly string[],
  out: unknown[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPath(item, segments, out);
    return;
  }
  const [head, ...rest] = segments;
  if (head === undefined) {
    if (node !== undefined && node !== null) out.push(node);
    return;
  }
  if (!isRecord(node) || !Object.hasOwn(node, head)) return;
  collectPath(node[head], rest, out);
}

export function resolvePathValues(view: unknown, path: string): unknown[] {
  const out: unknown[] = [];
  collectPath(view, path.split("."), out);
  return out;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function scalarTexts(values: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const value of values) {
    const text = scalarText(value);
    if (text !== null) texts.push(text);
  }
  return texts;
}

export function matchesWhere(view: unknown, clause: EventWhere): boolean {
  const found = resolvePathValues(view, clause.path);
  switch (clause.op) {
    case "exists":
      return found.length > 0;
    case "!exists":
      return found.length === 0;
    case "=":
      return scalarTexts(found).some((text) => text === clause.values[0]);
    case "!=":
      return !scalarTexts(found).some((text) => text === clause.values[0]);
    case "in":
      return scalarTexts(found).some((text) => clause.values.includes(text));
    case "within":
      return scalarTexts(found).every((text) => clause.values.includes(text));
    case "contains": {
      const needle = clause.values[0];
      if (needle === undefined) return false;
      return scalarTexts(found).some((text) => text.includes(needle));
    }
    case "!contains": {
      const needle = clause.values[0];
      if (needle === undefined) return false;
      return !scalarTexts(found).some((text) => text.includes(needle));
    }
  }
}

export function matchesEventKind(
  patterns: readonly string[],
  kind: string,
): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern === "*" || pattern === kind) return true;
    if (pattern.endsWith(".*")) {
      return kind.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}

export type EventMatch = { matched: true } | { matched: false; reason: string };

export function matchEvent(args: {
  trigger: Pick<AutomationEventTrigger, "events" | "where">;
  kind: string;
  view: unknown;
}): EventMatch {
  if (!matchesEventKind(args.trigger.events, args.kind)) {
    return { matched: false, reason: `kind ${args.kind} is not selected` };
  }
  for (const clause of args.trigger.where) {
    if (!matchesWhere(args.view, clause)) {
      return {
        matched: false,
        reason: `filter ${formatWhere(clause)} did not match`,
      };
    }
  }
  return { matched: true };
}

export function formatWhere(clause: EventWhere): string {
  return [clause.path, clause.op, clause.values.join(",")]
    .filter((part) => part !== "")
    .join(" ");
}

export function parseWhereExpression(expression: string): EventWhere {
  const match = /^\s*(\S+)\s+(\S+)(?:\s+([\s\S]*?))?\s*$/u.exec(expression);
  if (match === null) {
    throw new Error(
      `Invalid --where "${expression}". Use "<path> <op> [values]" with op one of ${eventWhereOpSchema.options.join(" ")}.`,
    );
  }
  const [, path = "", rawOp = "", rawValues = ""] = match;
  const op = eventWhereOpSchema.safeParse(rawOp);
  if (!op.success) {
    throw new Error(
      `Invalid --where operator "${rawOp}". Use one of ${eventWhereOpSchema.options.join(" ")}.`,
    );
  }
  if (!EVENT_PATH_PATTERN.test(path)) {
    throw new Error(
      `Invalid --where path "${path}". Use dot-separated names, at most 8 levels.`,
    );
  }
  const values =
    op.data === "in" || op.data === "within"
      ? rawValues
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "")
      : rawValues === ""
        ? []
        : [rawValues];
  return { path, op: op.data, values };
}

export function assertWhereWithinLimit(where: readonly EventWhere[]): void {
  if (where.length > EVENT_WHERE_CLAUSES_MAX) {
    throw new Error(
      `At most ${EVENT_WHERE_CLAUSES_MAX} filters are allowed per automation`,
    );
  }
}

function pickInto(
  source: unknown,
  segments: readonly string[],
): unknown | undefined {
  if (Array.isArray(source)) {
    const items = source
      .map((item) => pickInto(item, segments))
      .filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  const [head, ...rest] = segments;
  if (head === undefined) return source;
  if (!isRecord(source) || !Object.hasOwn(source, head)) return undefined;
  const child = pickInto(source[head], rest);
  if (child === undefined) return undefined;
  const out: JsonRecord = Object.create(null);
  out[head] = child;
  return out;
}

function mergePicked(target: unknown, addition: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(addition)) {
    return target.map((item, index) =>
      index < addition.length ? mergePicked(item, addition[index]) : item,
    );
  }
  if (isRecord(target) && isRecord(addition)) {
    const merged: JsonRecord = Object.create(null);
    for (const key of Object.keys(target)) merged[key] = target[key];
    for (const key of Object.keys(addition)) {
      merged[key] = Object.hasOwn(merged, key)
        ? mergePicked(merged[key], addition[key])
        : addition[key];
    }
    return merged;
  }
  return addition;
}

export function pickFields(
  payload: unknown,
  paths: readonly string[],
): unknown {
  if (paths.length === 0) return payload;
  let picked: unknown = Object.create(null);
  for (const path of paths) {
    const next = pickInto(payload, path.split("."));
    if (next !== undefined) picked = mergePicked(picked, next);
  }
  return picked;
}
