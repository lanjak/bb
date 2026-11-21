import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const GIT_STORAGE_MIGRATIONS: string[] = [
  `CREATE TABLE viewed_files (
    environment_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    path TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (environment_id, target_key, path)
  ) WITHOUT ROWID`,
  `CREATE TABLE diff_comments (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('new', 'old')),
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    anchor_lines TEXT NOT NULL,
    context_before TEXT NOT NULL,
    context_after TEXT NOT NULL,
    anchor_blob TEXT NOT NULL,
    created_target_key TEXT NOT NULL,
    body TEXT NOT NULL,
    author_thread_id TEXT,
    author_person INTEGER NOT NULL DEFAULT 0,
    sent_batch_id TEXT,
    sent_thread_id TEXT,
    sent_at INTEGER,
    resolved_at INTEGER,
    resolved_by_thread_id TEXT,
    resolution_note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX diff_comments_environment
    ON diff_comments (environment_id, resolved_at, path)`,
  `CREATE TABLE diff_comment_batches (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    comment_ids TEXT NOT NULL,
    include_sent INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
];

export type GitDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export function openGitDatabase(bb: BbPluginApi): GitDatabase {
  const db = bb.storage.database();
  bb.storage.migrate(db, GIT_STORAGE_MIGRATIONS);
  return db;
}
