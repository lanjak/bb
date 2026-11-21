import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { GIT_STORAGE_MIGRATIONS, openGitDatabase } from "./storage.js";

const sha256 = (statement: string) =>
  createHash("sha256").update(statement).digest("hex");

const VIEWED_STATEMENT_ON_MAIN = `CREATE TABLE viewed_files (
    environment_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    path TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (environment_id, target_key, path)
  ) WITHOUT ROWID`;

const PINNED_HASHES = [
  "5e99c4a4a2c31bb3e655835fb67ccae164a64fe7244c5b75cb9adc8a3d39df94",
  "6007e9efd9b2650bba96baacd7f58ef1a9b1474127aebdb6980972c4f4e55fba",
  "e5c6a6739568550baf7964cd6c3d16963f85ac3a0921c3af2c2dafcc51ba0d43",
  "ca31451f70933b39d5300381557daaeb6272eaae08afe7e76c199f8062da338f",
];

describe("git plugin storage migrations", () => {
  it("keeps the Viewed statement that main shipped at index 0, byte for byte", () => {
    expect(GIT_STORAGE_MIGRATIONS[0]).toBe(VIEWED_STATEMENT_ON_MAIN);
  });

  it("pins every index, so a reorder, an insertion or an edit of an old statement fails here", () => {
    expect(GIT_STORAGE_MIGRATIONS.map(sha256)).toEqual(PINNED_HASHES);
  });

  it("upgrades a database that main created and keeps its Viewed marks", () => {
    const fake = createFakePluginHost({
      pluginId: "bb--git",
      sdk: { subscribe: () => () => {} },
    });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [VIEWED_STATEMENT_ON_MAIN]);
    db.prepare(
      "INSERT INTO viewed_files VALUES ('env-1', 'uncommitted', 'a.ts', 'rev', 1)",
    ).run();
    openGitDatabase(fake.bb);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'diff_comment%' ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual(["diff_comment_batches", "diff_comments"]);
    expect(db.prepare("SELECT COUNT(*) FROM viewed_files").pluck().get()).toBe(
      1,
    );
  });

  it("opens an already upgraded database again", () => {
    const fake = createFakePluginHost({
      pluginId: "bb--git",
      sdk: { subscribe: () => () => {} },
    });
    openGitDatabase(fake.bb);
    expect(() => openGitDatabase(fake.bb)).not.toThrow();
  });
});
