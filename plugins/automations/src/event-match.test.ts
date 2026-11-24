import { describe, expect, it } from "vitest";
import {
  matchEvent,
  matchesEventKind,
  matchesWhere,
  parseWhereExpression,
  pickFields,
} from "./event-match.js";
import { eventWhereSchema, type EventWhere } from "./rpc-types.js";

const view = {
  action: "labeled",
  issue: {
    number: 7,
    state: "open",
    locked: false,
    title: "Crash on start",
    labels: [{ name: "bug" }, { name: "p1" }],
  },
  tags: ["a", "b"],
  nothing: null,
};

function clause(
  path: string,
  op: EventWhere["op"],
  ...values: string[]
): EventWhere {
  return { path, op, values };
}

describe("event where matcher", () => {
  it.each([
    [clause("issue.state", "=", "open"), true],
    [clause("issue.state", "=", "closed"), false],
    [clause("issue.number", "=", "7"), true],
    [clause("issue.locked", "=", "false"), true],
    [clause("issue.state", "!=", "closed"), true],
    [clause("issue.state", "!=", "open"), false],
    [clause("missing.path", "!=", "x"), true],
    [clause("issue.state", "in", "closed", "open"), true],
    [clause("issue.state", "in", "closed", "merged"), false],
    [clause("issue.title", "contains", "Crash"), true],
    [clause("issue.title", "contains", "crash"), false],
    [clause("issue.labels.name", "=", "p1"), true],
    [clause("issue.labels.name", "in", "docs", "bug"), true],
    [clause("issue.labels.name", "!=", "bug"), false],
    [clause("tags", "contains", "b"), true],
    [clause("issue.labels.name", "within", "bug", "p1"), true],
    [clause("issue.labels.name", "within", "bug"), false],
    [clause("missing.path", "within", "bug"), true],
    [clause("issue.title", "!contains", "Crash"), false],
    [clause("issue.title", "!contains", "other"), true],
    [clause("missing.path", "!contains", "x"), true],
    [clause("issue.number", "exists"), true],
    [clause("nothing", "exists"), false],
    [clause("missing", "!exists"), true],
    [clause("issue", "!exists"), false],
    [clause("__proto__.polluted", "exists"), false],
    [clause("constructor.name", "exists"), false],
  ])("%j -> %s", (where, expected) => {
    expect(matchesWhere(view, where)).toBe(expected);
  });

  it("requires every clause and names the one that failed", () => {
    const trigger = {
      events: ["issues.*"],
      where: [
        clause("issue.state", "=", "open"),
        clause("issue.labels.name", "=", "docs"),
      ],
    };
    expect(matchEvent({ trigger, kind: "issues.labeled", view })).toEqual({
      matched: false,
      reason: "filter issue.labels.name = docs did not match",
    });
    expect(matchEvent({ trigger, kind: "pull_request.opened", view })).toEqual({
      matched: false,
      reason: "kind pull_request.opened is not selected",
    });
    expect(
      matchEvent({
        trigger: { ...trigger, where: [clause("issue.state", "=", "open")] },
        kind: "issues.labeled",
        view,
      }),
    ).toEqual({ matched: true });
  });
});

describe("event kind patterns", () => {
  it.each([
    [[], "anything", true],
    [["push"], "push", true],
    [["push"], "push.extra", false],
    [["issues.*"], "issues.labeled", true],
    [["issues.*"], "issues", false],
    [["*"], "x", true],
    [["a", "b"], "b", true],
  ])("%j matches %s -> %s", (patterns, kind, expected) => {
    expect(matchesEventKind(patterns, kind)).toBe(expected);
  });
});

describe("where expressions", () => {
  it.each([
    ["issue.state = open", clause("issue.state", "=", "open")],
    [
      "sender.login in alice, bob",
      clause("sender.login", "in", "alice", "bob"),
    ],
    ["title contains hello world", clause("title", "contains", "hello world")],
    ["a.b exists", clause("a.b", "exists")],
  ])("parses %s", (expression, expected) => {
    expect(parseWhereExpression(expression)).toEqual(expected);
  });

  it.each([
    "justapath",
    "a.b ~~ c",
    "a..b = c",
    "a.b.c.d.e.f.g.h.i = c",
    "1abc = c",
  ])("rejects %s", (expression) => {
    expect(() => parseWhereExpression(expression)).toThrow();
  });

  it("rejects clauses whose values do not fit the operator", () => {
    expect(
      eventWhereSchema.safeParse({ path: "a", op: "exists", values: ["x"] })
        .success,
    ).toBe(false);
    expect(eventWhereSchema.safeParse({ path: "a", op: "=" }).success).toBe(
      false,
    );
    expect(
      eventWhereSchema.safeParse({ path: "a", op: "=", values: ["x", "y"] })
        .success,
    ).toBe(false);
  });
});

describe("pickFields", () => {
  it("keeps only the named paths, through arrays", () => {
    expect(
      JSON.parse(
        JSON.stringify(
          pickFields(view, ["issue.title", "issue.labels.name", "action"]),
        ),
      ),
    ).toEqual({
      issue: {
        title: "Crash on start",
        labels: [{ name: "bug" }, { name: "p1" }],
      },
      action: "labeled",
    });
  });

  it("returns the whole payload without paths and ignores missing ones", () => {
    expect(pickFields(view, [])).toBe(view);
    expect(JSON.parse(JSON.stringify(pickFields(view, ["nope.here"])))).toEqual(
      {},
    );
  });
});
