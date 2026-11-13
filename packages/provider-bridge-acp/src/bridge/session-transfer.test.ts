import { describe, expect, it } from "vitest";
import {
  decodeAcpSessionDestination,
  decodeAcpSessionFiles,
} from "./session-transfer.js";

describe("decodeAcpSessionFiles", () => {
  it("accepts absolute paths with safe relative paths", () => {
    expect(
      decodeAcpSessionFiles({
        files: [
          { path: "/s/a.jsonl", relativePath: "a.jsonl" },
          { path: "/s/d/b", relativePath: "d/b", extra: 1 },
        ],
      }),
    ).toEqual([
      { path: "/s/a.jsonl", relativePath: "a.jsonl" },
      { path: "/s/d/b", relativePath: "d/b" },
    ]);
    expect(decodeAcpSessionFiles({ files: [] })).toEqual([]);
  });

  it.each([
    ["relative path", { path: "s/a", relativePath: "a" }],
    ["empty path", { path: "", relativePath: "a" }],
    ["dotdot", { path: "/s/a", relativePath: "../a" }],
    ["nested dotdot", { path: "/s/a", relativePath: "d/../a" }],
    ["absolute relativePath", { path: "/s/a", relativePath: "/a" }],
    ["drive letter", { path: "/s/a", relativePath: "C:/a" }],
    ["backslash", { path: "/s/a", relativePath: "d\\a" }],
    ["empty segment", { path: "/s/a", relativePath: "d//a" }],
    ["dot segment", { path: "/s/a", relativePath: "./a" }],
    ["empty relativePath", { path: "/s/a", relativePath: "" }],
  ])("rejects %s", (_name, file) => {
    expect(() => decodeAcpSessionFiles({ files: [file] })).toThrow(
      /invalid _bb.dev\/session\/files answer/u,
    );
  });

  it("rejects duplicates and malformed answers", () => {
    expect(() =>
      decodeAcpSessionFiles({
        files: [
          { path: "/s/a", relativePath: "a" },
          { path: "/s/b", relativePath: "a" },
        ],
      }),
    ).toThrow(/listed twice/u);
    expect(() => decodeAcpSessionFiles({})).toThrow(/expected/u);
    expect(() => decodeAcpSessionFiles(null)).toThrow(/expected/u);
  });
});

describe("decodeAcpSessionDestination", () => {
  it("accepts a directory inside or equal to the root", () => {
    expect(
      decodeAcpSessionDestination({ root: "/r", directory: "/r/p/s" }),
    ).toEqual({ root: "/r", directory: "/r/p/s" });
    expect(
      decodeAcpSessionDestination({ root: "/r", directory: "/r" }),
    ).toEqual({ root: "/r", directory: "/r" });
  });

  it.each([
    ["outside the root", { root: "/r", directory: "/other/s" }],
    ["escaping via dotdot", { root: "/r", directory: "/r/../x" }],
    ["sharing only a prefix", { root: "/r", directory: "/rx/s" }],
    ["relative root", { root: "r", directory: "/r/s" }],
    ["relative directory", { root: "/r", directory: "s" }],
  ])("rejects a directory %s", (_name, answer) => {
    expect(() => decodeAcpSessionDestination(answer)).toThrow(
      /invalid _bb.dev\/session\/destination answer/u,
    );
  });

  it("rejects a malformed answer", () => {
    expect(() => decodeAcpSessionDestination({ root: "/r" })).toThrow(
      /expected/u,
    );
  });
});
