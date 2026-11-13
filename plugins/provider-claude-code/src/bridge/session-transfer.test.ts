import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeProjectFolderName,
  claudeSessionDestination,
  listClaudeSessionFiles,
} from "./session-transfer.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeConfigDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-claude-session-files-"));
  tempDirs.push(directory);
  return directory;
}

describe("claudeProjectFolderName", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(claudeProjectFolderName("/home/rufi/my.project_1")).toBe(
      "-home-rufi-my-project-1",
    );
  });

  it("matches the SDK for non-BMP and accented characters", () => {
    expect(claudeProjectFolderName("/work/\u{1F680}/app")).toBe("-work----app");
    expect(claudeProjectFolderName("/home/\u00fcn\u00ef/x")).toBe(
      "-home--n--x",
    );
    expect(claudeProjectFolderName(`/${"\u{1F680}".repeat(120)}`)).toBe(
      `${"-".repeat(200)}-6nzpex`,
    );
  });

  it("truncates long paths and appends a base36 hash of the full path", () => {
    const cwd = `/${"a".repeat(250)}`;
    const name = claudeProjectFolderName(cwd);
    expect(name.startsWith(`-${"a".repeat(199)}-`)).toBe(true);
    expect(name.length).toBeLessThan(215);
    expect(name).not.toBe(claudeProjectFolderName(`${cwd}b`));
    expect(claudeProjectFolderName(cwd)).toBe(name);
  });

  it("places the destination under the config directory projects folder", () => {
    expect(
      claudeSessionDestination({ configDirectory: "/c", cwd: "/work/app" }),
    ).toBe("/c/projects/-work-app");
  });
});

describe("listClaudeSessionFiles", () => {
  it("lists the transcript and every regular sidecar file", async () => {
    const configDirectory = makeConfigDir();
    const projectDir = join(configDirectory, "projects", "-other");
    mkdirSync(join(projectDir, "s1", "tool-results"), { recursive: true });
    writeFileSync(join(projectDir, "s1.jsonl"), "t");
    writeFileSync(join(projectDir, "s1", "tool-results", "r.txt"), "r");
    writeFileSync(join(projectDir, "s2.jsonl"), "other session");

    const files = await listClaudeSessionFiles({
      configDirectory,
      cwd: "/work/app",
      sessionId: "s1",
    });

    expect(files.map((file) => file.relativePath)).toEqual([
      "s1.jsonl",
      "s1/tool-results/r.txt",
    ]);
    expect(files[0]?.path).toBe(join(projectDir, "s1.jsonl"));
  });

  it("fails the listing when a sidecar entry is a symlink", async () => {
    const configDirectory = makeConfigDir();
    const projectDir = join(configDirectory, "projects", "-other");
    mkdirSync(join(projectDir, "s1"), { recursive: true });
    writeFileSync(join(projectDir, "s1.jsonl"), "t");
    symlinkSync("/etc/hostname", join(projectDir, "s1", "link"));

    await expect(
      listClaudeSessionFiles({ configDirectory, cwd: "/x", sessionId: "s1" }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("lists only the transcript when the sidecar folder is absent", async () => {
    const configDirectory = makeConfigDir();
    const projectDir = join(configDirectory, "projects", "-other");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "s1.jsonl"), "t");

    const files = await listClaudeSessionFiles({
      configDirectory,
      cwd: "/x",
      sessionId: "s1",
    });
    expect(files.map((file) => file.relativePath)).toEqual(["s1.jsonl"]);
  });

  it("prefers the project folder for the cwd when several hold the session", async () => {
    const configDirectory = makeConfigDir();
    for (const folder of ["-aaa", "-work-app"]) {
      mkdirSync(join(configDirectory, "projects", folder), { recursive: true });
      writeFileSync(join(configDirectory, "projects", folder, "s1.jsonl"), "t");
    }

    const files = await listClaudeSessionFiles({
      configDirectory,
      cwd: "/work/app",
      sessionId: "s1",
    });

    expect(files.map((file) => file.path)).toEqual([
      join(configDirectory, "projects", "-work-app", "s1.jsonl"),
    ]);
  });

  it("returns no files for an unknown session and refuses unsafe ids", async () => {
    const configDirectory = makeConfigDir();
    await expect(
      listClaudeSessionFiles({ configDirectory, cwd: "/x", sessionId: "nope" }),
    ).resolves.toEqual([]);
    await expect(
      listClaudeSessionFiles({
        configDirectory,
        cwd: "/x",
        sessionId: "../escape",
      }),
    ).rejects.toThrow(/Invalid Claude session id/);
  });
});
