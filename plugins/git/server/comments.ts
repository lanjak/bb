import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GIT_COMMENTS_MAX_PER_ENVIRONMENT,
  type GitCommentAnchor,
} from "../contract.js";
import type { GitDatabase } from "./storage.js";

const UNRESOLVED_BATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const stringArraySchema = z.array(z.string());

function parseStringArray(value: string): string[] {
  return stringArraySchema.parse(JSON.parse(value));
}

const commentRowSchema = z.object({
  id: z.string(),
  environment_id: z.string(),
  path: z.string(),
  side: z.enum(["new", "old"]),
  start_line: z.number().int(),
  end_line: z.number().int(),
  anchor_lines: z.string(),
  context_before: z.string(),
  context_after: z.string(),
  anchor_blob: z.string(),
  created_target_key: z.string(),
  body: z.string(),
  author_thread_id: z.string().nullable(),
  author_person: z.number().int(),
  sent_batch_id: z.string().nullable(),
  sent_thread_id: z.string().nullable(),
  sent_at: z.number().int().nullable(),
  resolved_at: z.number().int().nullable(),
  resolved_by_thread_id: z.string().nullable(),
  resolution_note: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export interface StoredComment {
  id: string;
  environmentId: string;
  path: string;
  side: "new" | "old";
  startLine: number;
  endLine: number;
  lines: string[];
  contextBefore: string[];
  contextAfter: string[];
  anchorBlob: string;
  createdTargetKey: string;
  body: string;
  authorThreadId?: string;
  authorPerson: boolean;
  sent?: { batchId: string; threadId: string; at: number };
  resolution?: { at: number; byThreadId?: string; note?: string };
  createdAt: number;
  updatedAt: number;
}

function toStoredComment(raw: unknown): StoredComment {
  const row = commentRowSchema.parse(raw);
  return {
    id: row.id,
    environmentId: row.environment_id,
    path: row.path,
    side: row.side,
    startLine: row.start_line,
    endLine: row.end_line,
    lines: parseStringArray(row.anchor_lines),
    contextBefore: parseStringArray(row.context_before),
    contextAfter: parseStringArray(row.context_after),
    anchorBlob: row.anchor_blob,
    createdTargetKey: row.created_target_key,
    body: row.body,
    ...(row.author_thread_id === null
      ? {}
      : { authorThreadId: row.author_thread_id }),
    authorPerson: row.author_person === 1,
    ...(row.sent_batch_id === null ||
    row.sent_thread_id === null ||
    row.sent_at === null
      ? {}
      : {
          sent: {
            batchId: row.sent_batch_id,
            threadId: row.sent_thread_id,
            at: row.sent_at,
          },
        }),
    ...(row.resolved_at === null
      ? {}
      : {
          resolution: {
            at: row.resolved_at,
            ...(row.resolved_by_thread_id === null
              ? {}
              : { byThreadId: row.resolved_by_thread_id }),
            ...(row.resolution_note === null
              ? {}
              : { note: row.resolution_note }),
          },
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const batchRowSchema = z.object({
  id: z.string(),
  environment_id: z.string(),
  thread_id: z.string(),
  comment_ids: z.string(),
  include_sent: z.number().int(),
  created_at: z.number().int(),
  resolved_at: z.number().int().nullable(),
});

export interface StoredBatch {
  id: string;
  environmentId: string;
  threadId: string;
  commentIds: string[];
  includeSent: boolean;
  createdAt: number;
  resolvedAt?: number;
}

function toStoredBatch(raw: unknown): StoredBatch {
  const row = batchRowSchema.parse(raw);
  return {
    id: row.id,
    environmentId: row.environment_id,
    threadId: row.thread_id,
    commentIds: parseStringArray(row.comment_ids),
    includeSent: row.include_sent === 1,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  };
}

export interface NewComment {
  environmentId: string;
  anchor: GitCommentAnchor;
  anchorBlob: string;
  createdTargetKey: string;
  body: string;
  authorThreadId?: string;
  authorPerson: boolean;
}

export interface CommentSelection {
  environmentId: string;
  ids?: readonly string[];
  includeSent: boolean;
  path?: string;
}

export class CommentLimitError extends Error {}

function newId(prefix: "dcm" | "dcb"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export interface GitCommentStore {
  add(comment: NewComment): StoredComment;
  get(id: string): StoredComment | undefined;
  list(environmentId: string, includeResolved: boolean): StoredComment[];
  getMany(ids: readonly string[]): StoredComment[];
  select(selection: CommentSelection): StoredComment[];
  edit(id: string, body: string): StoredComment | undefined;
  remove(id: string): StoredComment | undefined;
  resolve(
    id: string,
    resolution: { note?: string; byThreadId?: string },
  ): StoredComment | undefined;
  reopen(id: string): StoredComment | undefined;
  createBatch(args: {
    environmentId: string;
    threadId: string;
    commentIds: readonly string[];
    includeSent: boolean;
  }): StoredBatch;
  findUnresolvedBatch(args: {
    environmentId: string;
    threadId: string;
    commentIds: readonly string[];
    includeSent: boolean;
  }): StoredBatch | undefined;
  getBatch(id: string): StoredBatch | undefined;
  markBatchSent(batch: StoredBatch, commentIds: readonly string[]): string[];
  forgetEnvironment(environmentId: string): void;
  environmentsWithComments(): string[];
  pruneBatches(): void;
}

export function createGitCommentStore(db: GitDatabase): GitCommentStore {
  const insert = db.prepare(
    `INSERT INTO diff_comments (
       id, environment_id, path, side, start_line, end_line, anchor_lines,
       context_before, context_after, anchor_blob, created_target_key, body,
       author_thread_id, author_person, created_at, updated_at
     ) VALUES (
       @id, @environmentId, @path, @side, @startLine, @endLine, @anchorLines,
       @contextBefore, @contextAfter, @anchorBlob, @createdTargetKey, @body,
       @authorThreadId, @authorPerson, @now, @now
     )`,
  );
  const byId = db.prepare("SELECT * FROM diff_comments WHERE id = ?");

  function get(id: string): StoredComment | undefined {
    const row = byId.get(id);
    return row === undefined ? undefined : toStoredComment(row);
  }

  function getMany(ids: readonly string[]): StoredComment[] {
    if (ids.length === 0) return [];
    return db
      .prepare(
        `SELECT * FROM diff_comments
         WHERE id IN (SELECT value FROM json_each(?))
         ORDER BY path, start_line, created_at`,
      )
      .all(JSON.stringify(ids))
      .map(toStoredComment);
  }

  return {
    add(comment) {
      const count = z
        .number()
        .parse(
          db
            .prepare(
              "SELECT COUNT(*) FROM diff_comments WHERE environment_id = ?",
            )
            .pluck()
            .get(comment.environmentId),
        );
      if (count >= GIT_COMMENTS_MAX_PER_ENVIRONMENT) {
        throw new CommentLimitError(
          `An environment can hold at most ${GIT_COMMENTS_MAX_PER_ENVIRONMENT} comments. Delete or resolve some first.`,
        );
      }
      const id = newId("dcm");
      insert.run({
        id,
        environmentId: comment.environmentId,
        path: comment.anchor.path,
        side: comment.anchor.side,
        startLine: comment.anchor.startLine,
        endLine: comment.anchor.endLine,
        anchorLines: JSON.stringify(comment.anchor.lines),
        contextBefore: JSON.stringify(comment.anchor.contextBefore),
        contextAfter: JSON.stringify(comment.anchor.contextAfter),
        anchorBlob: comment.anchorBlob,
        createdTargetKey: comment.createdTargetKey,
        body: comment.body,
        authorThreadId: comment.authorThreadId ?? null,
        authorPerson:
          comment.authorThreadId === undefined && comment.authorPerson ? 1 : 0,
        now: Date.now(),
      });
      const stored = get(id);
      if (stored === undefined) throw new Error("Comment was not stored");
      return stored;
    },
    get,
    getMany,
    list(environmentId, includeResolved) {
      return db
        .prepare(
          `SELECT * FROM diff_comments
           WHERE environment_id = ?${includeResolved ? "" : " AND resolved_at IS NULL"}
           ORDER BY path, start_line, created_at`,
        )
        .all(environmentId)
        .map(toStoredComment);
    },
    select(selection) {
      const rows = db
        .prepare(
          `SELECT * FROM diff_comments
           WHERE environment_id = @environmentId
             AND resolved_at IS NULL
             AND (@includeSent = 1 OR sent_batch_id IS NULL)
             AND (@path IS NULL OR path = @path)
             AND (@ids IS NULL OR id IN (SELECT value FROM json_each(@ids)))
           ORDER BY path, start_line, created_at`,
        )
        .all({
          environmentId: selection.environmentId,
          includeSent:
            selection.includeSent || selection.ids !== undefined ? 1 : 0,
          path: selection.path ?? null,
          ids:
            selection.ids === undefined ? null : JSON.stringify(selection.ids),
        });
      return rows.map(toStoredComment);
    },
    edit(id, body) {
      const result = db
        .prepare(
          `UPDATE diff_comments
           SET body = ?, sent_batch_id = NULL, sent_thread_id = NULL,
               sent_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(body, Date.now(), id);
      return result.changes === 0 ? undefined : get(id);
    },
    remove(id) {
      const existing = get(id);
      if (existing === undefined) return undefined;
      db.prepare("DELETE FROM diff_comments WHERE id = ?").run(id);
      return existing;
    },
    resolve(id, resolution) {
      const now = Date.now();
      const result = db
        .prepare(
          `UPDATE diff_comments
           SET resolved_at = ?, resolved_by_thread_id = ?, resolution_note = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          now,
          resolution.byThreadId ?? null,
          resolution.note ?? null,
          now,
          id,
        );
      return result.changes === 0 ? undefined : get(id);
    },
    reopen(id) {
      const result = db
        .prepare(
          `UPDATE diff_comments
           SET resolved_at = NULL, resolved_by_thread_id = NULL,
               resolution_note = NULL, sent_batch_id = NULL,
               sent_thread_id = NULL, sent_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), id);
      return result.changes === 0 ? undefined : get(id);
    },
    createBatch({ environmentId, threadId, commentIds, includeSent }) {
      const id = newId("dcb");
      db.prepare(
        `INSERT INTO diff_comment_batches
           (id, environment_id, thread_id, comment_ids, include_sent, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        environmentId,
        threadId,
        JSON.stringify(commentIds),
        includeSent ? 1 : 0,
        Date.now(),
      );
      const row = db
        .prepare("SELECT * FROM diff_comment_batches WHERE id = ?")
        .get(id);
      return toStoredBatch(row);
    },
    findUnresolvedBatch({ environmentId, threadId, commentIds, includeSent }) {
      const row = db
        .prepare(
          `SELECT * FROM diff_comment_batches
           WHERE environment_id = ? AND thread_id = ? AND comment_ids = ?
             AND include_sent = ? AND resolved_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(
          environmentId,
          threadId,
          JSON.stringify(commentIds),
          includeSent ? 1 : 0,
        );
      return row === undefined ? undefined : toStoredBatch(row);
    },
    getBatch(id) {
      const row = db
        .prepare("SELECT * FROM diff_comment_batches WHERE id = ?")
        .get(id);
      return row === undefined ? undefined : toStoredBatch(row);
    },
    markBatchSent(batch, commentIds) {
      const now = Date.now();
      const marked = db.transaction(() => {
        const rows = db
          .prepare(
            `UPDATE diff_comments
             SET sent_batch_id = ?, sent_thread_id = ?, sent_at = ?
             WHERE environment_id = ? AND resolved_at IS NULL
               AND id IN (SELECT value FROM json_each(?))
             RETURNING id`,
          )
          .pluck()
          .all(
            batch.id,
            batch.threadId,
            now,
            batch.environmentId,
            JSON.stringify(commentIds),
          );
        db.prepare(
          "UPDATE diff_comment_batches SET resolved_at = ? WHERE id = ?",
        ).run(now, batch.id);
        return rows;
      })();
      return stringArraySchema.parse(marked);
    },
    forgetEnvironment(environmentId) {
      db.transaction(() => {
        db.prepare("DELETE FROM diff_comments WHERE environment_id = ?").run(
          environmentId,
        );
        db.prepare(
          "DELETE FROM diff_comment_batches WHERE environment_id = ?",
        ).run(environmentId);
      })();
    },
    environmentsWithComments() {
      return stringArraySchema.parse(
        db
          .prepare(
            `SELECT environment_id FROM diff_comments
             UNION SELECT environment_id FROM diff_comment_batches`,
          )
          .pluck()
          .all(),
      );
    },
    pruneBatches() {
      const now = Date.now();
      db.prepare(
        `DELETE FROM diff_comment_batches
         WHERE (resolved_at IS NULL AND created_at < ?) OR created_at < ?`,
      ).run(now - UNRESOLVED_BATCH_RETENTION_MS, now - BATCH_RETENTION_MS);
    },
  };
}
