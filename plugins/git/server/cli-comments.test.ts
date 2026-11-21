import { describe, expect, it } from "vitest";
import { commentsHost, lines } from "./comments-test-host.js";

async function cli(
  host: Awaited<ReturnType<typeof commentsHost>>,
  argv: string[],
  ctx: { threadId?: string } = {},
) {
  return host.fake.harness.runCli(argv, ctx);
}

async function seeded() {
  const host = await commentsHost();
  await host.setFile({
    content: lines("alpha", "beta", "gamma", "delta", "epsilon", "zeta"),
    newBlob: "b1b1b1",
  });
  return host;
}

function idFrom(stdout: string): string {
  const match = /dcm_[0-9a-f]{16}/u.exec(stdout);
  if (match === null) throw new Error(`no comment id in: ${stdout}`);
  return match[0];
}

describe("bb git comments", () => {
  it("adds a comment from the file's lines, lists it, and resolves it with a note from an agent thread", async () => {
    const host = await seeded();
    const added = await cli(
      host,
      [
        "comments",
        "add",
        "env-1",
        "--path",
        "src/a.ts",
        "--line",
        "3-4",
        "--body",
        "Cache this",
      ],
      { threadId: "thr-1" },
    );
    expect(added.stderr).toBe("");
    expect(added.exitCode).toBe(0);
    const id = idFrom(added.stdout);

    const listed = await cli(host, ["comments", "list", "env-1"]);
    expect(listed.stdout).toContain(id);
    expect(listed.stdout).toContain("src/a.ts");
    expect(listed.stdout).toContain("lines 3-4");
    expect(listed.stdout).toContain("by thread:thr-1");
    expect(listed.stdout).toContain("  Cache this");

    const json = await cli(host, ["comments", "list", "env-1", "--json"]);
    const parsed = JSON.parse(json.stdout) as {
      comments: Array<Record<string, unknown>>;
    };
    expect(parsed.comments[0]).toMatchObject({
      id,
      side: "new",
      startLine: 3,
      endLine: 4,
      lines: ["gamma", "delta"],
      contextBefore: ["alpha", "beta"],
      contextAfter: ["epsilon", "zeta"],
      state: "unsent",
    });

    const resolved = await cli(
      host,
      ["comments", "resolve", id, "--note", "Added a cache"],
      { threadId: "thr-1" },
    );
    expect(resolved.exitCode).toBe(0);
    expect((await cli(host, ["comments", "list", "env-1"])).stdout).toBe(
      "No open comments.\n",
    );
    const all = await cli(host, ["comments", "list", "env-1", "--all"]);
    expect(all.stdout).toContain("resolved");
    expect(all.stdout).toContain("Resolved: Added a cache");
    expect(await host.list(true)).toEqual([
      expect.objectContaining({
        resolution: expect.objectContaining({ byThreadId: "thr-1" }),
      }),
    ]);

    await cli(host, ["comments", "reopen", id]);
    expect((await cli(host, ["comments", "list", "env-1"])).stdout).toContain(
      id,
    );
    await cli(host, ["comments", "edit", id, "--body", "Edited"]);
    expect((await cli(host, ["comments", "list", "env-1"])).stdout).toContain(
      "  Edited",
    );
    await cli(host, ["comments", "delete", id]);
    expect((await cli(host, ["comments", "list", "env-1"])).stdout).toBe(
      "No open comments.\n",
    );
  });

  it("defaults list to the calling thread's environment", async () => {
    const host = await seeded();
    await cli(host, [
      "comments",
      "add",
      "env-1",
      "--path",
      "src/a.ts",
      "--line",
      "2",
      "--body",
      "Look",
    ]);
    const fromThread = await cli(host, ["comments", "list"], {
      threadId: "thr-1",
    });
    expect(fromThread.exitCode).toBe(0);
    expect(fromThread.stdout).toContain("lines 2-2");
    expect(fromThread.stdout).toContain("by user");
    const other = await cli(host, ["comments", "list"], { threadId: "thr-2" });
    expect(other.stdout).toBe("No open comments.\n");
    const none = await cli(host, ["comments", "list"]);
    expect(none.exitCode).not.toBe(0);
    expect(none.stderr).toContain("Provide an environment id");
  });

  it("refuses bad input with a message", async () => {
    const host = await seeded();
    const base = ["comments", "add", "env-1", "--body", "x"];
    const badLine = await cli(host, [
      ...base,
      "--path",
      "src/a.ts",
      "--line",
      "5-2",
    ]);
    expect(badLine.exitCode).not.toBe(0);
    expect(badLine.stderr).toContain("Invalid --line");

    const outside = await cli(host, [
      ...base,
      "--path",
      "src/a.ts",
      "--line",
      "40",
    ]);
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toContain("has 6 lines");

    const unchanged = await cli(host, [
      ...base,
      "--path",
      "src/untouched.ts",
      "--line",
      "1",
    ]);
    expect(unchanged.exitCode).not.toBe(0);
    expect(unchanged.stderr).toContain("not a changed file");

    const missing = await cli(host, [
      "comments",
      "resolve",
      "dcm_0000000000000000",
    ]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("Comment not found");
  });

  it("sends the open comments to a thread and prints the count", async () => {
    const host = await seeded();
    await cli(host, [
      "comments",
      "add",
      "env-1",
      "--path",
      "src/a.ts",
      "--line",
      "1",
      "--body",
      "One",
    ]);
    const sent = await cli(host, [
      "comments",
      "send",
      "env-1",
      "--thread",
      "thr-1",
      "--message",
      "Go",
    ]);
    expect(sent.stderr).toBe("");
    expect(sent.stdout).toBe("Sent 1 comments to thr-1.\n");
    expect(host.state.sent).toHaveLength(1);

    const wrongThread = await cli(host, [
      "comments",
      "send",
      "env-1",
      "--thread",
      "thr-2",
    ]);
    expect(wrongThread.exitCode).not.toBe(0);
    expect(wrongThread.stderr).toContain("different environment");
  });
});
