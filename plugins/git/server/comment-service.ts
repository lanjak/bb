import { resolveEnvironmentMergeBaseBranch } from "@bb/domain";
import {
  experimental_BbHttpError,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  GIT_COMMENT_BATCH_MAX_COMMENTS,
  GIT_COMMENT_CODE_MAX_BYTES,
  GIT_COMMENT_CONTEXT_LINES,
  GIT_COMMENT_MAX_LINES,
  GIT_COMMENT_MENTION_PROVIDER_ID,
  type DiffFileEntry,
  type GitComment,
  type GitCommentAnchor,
  type GitCommentPlacement,
  type GitFileSideQuery,
  type WorkspaceDiffTarget,
} from "../contract.js";
import {
  resolveCommentAnchor,
  splitFileLines,
  type CommentAnchor,
} from "./comment-anchor.js";
import {
  formatReviewCommentsContext,
  type PromptComment,
} from "./comment-prompt.js";
import {
  CommentLimitError,
  type GitCommentStore,
  type StoredBatch,
  type StoredComment,
} from "./comments.js";
import { requireGitEnvironment, type GitReads } from "./reads.js";
import { targetKey } from "./target-key.js";

const MAX_FILE_READS_PER_LIST = 50;
const FILE_READ_CONCURRENCY = 4;
const LINE_CACHE_MAX_ENTRIES = 64;
const BATCH_RESOLVE_DEADLINE_MS = 5_000;
const LIST_PLACEMENT_DEADLINE_MS = 8_000;
const ZERO_BLOB_PATTERN = /^0+$/u;

interface ResolvedPlacement {
  placement: GitCommentPlacement;
  currentPath?: string;
}

interface RevisionBlobs {
  old: string | null;
  new: string | null;
}

export interface CommentSelectionInput {
  environmentId: string;
  ids?: string[] | undefined;
  includeSent?: boolean | undefined;
  path?: string | undefined;
}

export interface AddCommentInput {
  environmentId: string;
  target: WorkspaceDiffTarget;
  revision: string;
  anchor: GitCommentAnchor;
  body: string;
  authorThreadId?: string | undefined;
  byPerson?: boolean | undefined;
}

export interface AddCommentFromFileInput {
  environmentId: string;
  target: WorkspaceDiffTarget;
  path: string;
  side: "new" | "old";
  startLine: number;
  endLine: number;
  body: string;
  authorThreadId?: string | undefined;
  byPerson?: boolean | undefined;
}

export interface GitCommentsService {
  environmentTarget(environmentId: string): Promise<WorkspaceDiffTarget>;
  list(
    environmentId: string,
    target: WorkspaceDiffTarget,
    includeResolved: boolean,
    signal?: AbortSignal,
  ): Promise<{ comments: GitComment[] }>;
  add(input: AddCommentInput): Promise<{ comment: GitComment }>;
  addFromFile(input: AddCommentFromFileInput): Promise<{ comment: GitComment }>;
  edit(id: string, body: string): { ok: true };
  remove(id: string): { ok: true };
  resolve(
    id: string,
    resolution: { note?: string | undefined; byThreadId?: string | undefined },
  ): { ok: true };
  reopen(id: string): { ok: true };
  createBatch(input: CommentSelectionInput & { threadId: string }): Promise<{
    batchId: string;
    count: number;
    omitted: number;
    label: string;
  }>;
  send(
    input: CommentSelectionInput & {
      threadId: string;
      message?: string | undefined;
    },
  ): Promise<{ batchId: string; count: number; omitted: number }>;
  resolveBatchContext(batchId: string): Promise<{ context: string }>;
  forgetDeletedEnvironments(
    exists: (environmentId: string) => Promise<boolean>,
  ): Promise<void>;
}

function refuse(
  code: experimental_PluginRpcRefusal["code"],
  message: string,
): never {
  throw new experimental_PluginRpcRefusal({ code, message });
}

export function blobsFromRevision(revision: string): RevisionBlobs {
  const parts = revision.split(":");
  const [, oldBlob, , newBlob] = parts;
  const usable = (blob: string | undefined): string | null =>
    parts.length === 4 &&
    blob !== undefined &&
    blob.length > 0 &&
    !ZERO_BLOB_PATTERN.test(blob)
      ? blob
      : null;
  return { old: usable(oldBlob), new: usable(newBlob) };
}

function fileSideQuery(
  target: WorkspaceDiffTarget,
  mergeBaseRef: string | null,
  path: string,
  side: "new" | "old",
): GitFileSideQuery | null {
  switch (target.type) {
    case "uncommitted":
      return { target: "uncommitted", path, side };
    case "commit":
      return { target: "commit", sha: target.sha, path, side };
    case "branch_committed":
    case "all":
      return mergeBaseRef === null
        ? null
        : { target: target.type, mergeBaseRef, path, side };
  }
}

function stateOf(comment: StoredComment): GitComment["state"] {
  if (comment.resolution !== undefined) return "resolved";
  return comment.sent === undefined ? "unsent" : "sent";
}

function toComment(
  comment: StoredComment,
  resolved: ResolvedPlacement,
): GitComment {
  return {
    id: comment.id as GitComment["id"],
    environmentId: comment.environmentId,
    path: comment.path,
    ...(resolved.currentPath === undefined
      ? {}
      : { currentPath: resolved.currentPath }),
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    lines: comment.lines,
    contextBefore: comment.contextBefore,
    contextAfter: comment.contextAfter,
    body: comment.body,
    author:
      comment.authorThreadId !== undefined
        ? { kind: "thread", threadId: comment.authorThreadId }
        : comment.authorPerson
          ? { kind: "user" }
          : { kind: "unspecified" },
    state: stateOf(comment),
    ...(comment.sent === undefined
      ? {}
      : { sent: comment.sent as NonNullable<GitComment["sent"]> }),
    ...(comment.resolution === undefined
      ? {}
      : { resolution: comment.resolution }),
    placement: resolved.placement,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function anchorOf(comment: StoredComment, blob: string): CommentAnchor {
  return {
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    lines: comment.lines,
    contextBefore: comment.contextBefore,
    contextAfter: comment.contextAfter,
    blob,
  };
}

async function withDeadlineAt<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => resolve(undefined),
      Math.max(0, deadlineAt - Date.now()),
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createGitCommentsService({
  bb,
  reads,
  store,
  changed,
}: {
  bb: BbPluginApi;
  reads: GitReads;
  store: GitCommentStore;
  changed: (environmentId: string) => void;
}): GitCommentsService {
  const lineCache = new Map<string, string[]>();
  async function environmentTarget(
    environmentId: string,
  ): Promise<WorkspaceDiffTarget> {
    const environment = await requireGitEnvironment(bb, environmentId);
    const mergeBaseBranch = resolveEnvironmentMergeBaseBranch(environment);
    return mergeBaseBranch === undefined
      ? { type: "uncommitted" }
      : { type: "all", mergeBaseBranch };
  }

  async function readSideLines(args: {
    environmentId: string;
    target: WorkspaceDiffTarget;
    mergeBaseRef: string | null;
    path: string;
    side: "new" | "old";
  }): Promise<string[] | null> {
    const query = fileSideQuery(
      args.target,
      args.mergeBaseRef,
      args.path,
      args.side,
    );
    if (query === null) return null;
    try {
      const result = await reads.fileSide(args.environmentId, query);
      if (result.outcome === "unavailable") {
        return result.code === "ENOENT" ? [] : null;
      }
      if (result.file.contentEncoding !== "utf8") return null;
      return splitFileLines(result.file.content);
    } catch (error) {
      bb.log.debug(
        `Could not read ${args.path} for comments: ${String(error)}`,
      );
      return null;
    }
  }

  async function placementsFor(
    environmentId: string,
    target: WorkspaceDiffTarget,
    comments: readonly StoredComment[],
    limits: { deadlineAt: number; signal?: AbortSignal | undefined },
  ): Promise<Map<string, ResolvedPlacement>> {
    const placements = new Map<string, ResolvedPlacement>();
    if (comments.length === 0) return placements;
    const unknown: ResolvedPlacement = { placement: { kind: "unknown" } };
    const files = await withDeadlineAt(
      reads
        .files(environmentId, target, false, "shared")
        .catch((error: unknown) => {
          bb.log.debug(`Could not list files for comments: ${String(error)}`);
          return null;
        }),
      limits.deadlineAt,
    );
    if (
      files === undefined ||
      files === null ||
      files.outcome !== "available"
    ) {
      for (const comment of comments) placements.set(comment.id, unknown);
      return placements;
    }
    const byPath = new Map<string, DiffFileEntry>();
    const byPreviousPath = new Map<string, DiffFileEntry>();
    for (const file of files.files) {
      byPath.set(file.path, file);
      if (file.previousPath !== null)
        byPreviousPath.set(file.previousPath, file);
    }
    interface LineSource {
      side: "new" | "old";
      readPath: string;
      blob: string | null;
      wanted: boolean;
      lines: string[] | null;
    }
    const sources = new Map<string, LineSource>();
    const pending: Array<{
      comment: StoredComment;
      entry: DiffFileEntry;
      blob: string | null;
      sourceKey: string | null;
    }> = [];
    for (const comment of comments) {
      const entry =
        byPath.get(comment.path) ?? byPreviousPath.get(comment.path);
      if (entry === undefined) {
        placements.set(comment.id, { placement: { kind: "not_in_diff" } });
        continue;
      }
      const blobs = blobsFromRevision(entry.revision);
      const blob = comment.side === "new" ? blobs.new : blobs.old;
      if (blob === null || blob !== comment.anchorBlob) {
        const readPath =
          comment.side === "old"
            ? (entry.previousPath ?? entry.path)
            : entry.path;
        const sourceKey = `${comment.side}\u0000${readPath}`;
        const source = sources.get(sourceKey) ?? {
          side: comment.side,
          readPath,
          blob,
          wanted: false,
          lines: null,
        };
        if (comment.resolution === undefined) source.wanted = true;
        sources.set(sourceKey, source);
        pending.push({ comment, entry, blob, sourceKey });
      } else {
        pending.push({ comment, entry, blob, sourceKey: null });
      }
    }
    const reading: Array<() => Promise<void>> = [];
    for (const source of sources.values()) {
      const cacheKey =
        source.blob === null
          ? null
          : [environmentId, source.side, source.readPath, source.blob].join(
              "\u0000",
            );
      const cached = cacheKey === null ? undefined : lineCache.get(cacheKey);
      if (cached !== undefined) {
        lineCache.delete(cacheKey as string);
        lineCache.set(cacheKey as string, cached);
        source.lines = cached;
        continue;
      }
      if (!source.wanted || reading.length >= MAX_FILE_READS_PER_LIST) continue;
      reading.push(async () => {
        if (limits.signal?.aborted === true) return;
        const lines = await withDeadlineAt(
          readSideLines({
            environmentId,
            target,
            mergeBaseRef: files.mergeBaseRef,
            path: source.readPath,
            side: source.side,
          }),
          limits.deadlineAt,
        );
        if (lines === undefined || lines === null) return;
        source.lines = lines;
        if (cacheKey !== null) {
          lineCache.set(cacheKey, lines);
          if (lineCache.size > LINE_CACHE_MAX_ENTRIES) {
            const [oldest] = lineCache.keys();
            if (oldest !== undefined) lineCache.delete(oldest);
          }
        }
      });
    }
    let nextRead = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(FILE_READ_CONCURRENCY, reading.length) },
        async () => {
          while (nextRead < reading.length) {
            const run = reading[nextRead];
            nextRead += 1;
            await run?.();
          }
        },
      ),
    );
    for (const { comment, entry, blob, sourceKey } of pending) {
      const lines =
        sourceKey === null ? null : (sources.get(sourceKey)?.lines ?? null);
      const placement = resolveCommentAnchor(
        anchorOf(comment, comment.anchorBlob),
        { blob: blob ?? "", lines },
      );
      placements.set(comment.id, {
        placement,
        ...(entry.path === comment.path ? {} : { currentPath: entry.path }),
      });
    }
    return placements;
  }

  async function currentBlobAndLines(
    environmentId: string,
    target: WorkspaceDiffTarget,
    path: string,
    side: "new" | "old",
  ): Promise<{ blob: string | null; lines: string[] }> {
    const files = await reads.files(environmentId, target, false, "bypass");
    if (files.outcome !== "available") {
      refuse("conflict", "The diff is unavailable right now.");
    }
    const entry = files.files.find((candidate) => candidate.path === path);
    if (entry === undefined) {
      refuse("invalid", `${path} is not a changed file in this diff.`);
    }
    const lines = await readSideLines({
      environmentId,
      target,
      mergeBaseRef: files.mergeBaseRef,
      path: side === "old" ? (entry.previousPath ?? entry.path) : entry.path,
      side,
    });
    if (lines === null) refuse("conflict", `Could not read ${path}.`);
    const blobs = blobsFromRevision(entry.revision);
    return { blob: side === "new" ? blobs.new : blobs.old, lines };
  }

  function storeComment(input: {
    environmentId: string;
    target: WorkspaceDiffTarget;
    anchor: GitCommentAnchor;
    anchorBlob: string;
    body: string;
    authorThreadId: string | undefined;
    byPerson: boolean | undefined;
  }): { comment: GitComment } {
    try {
      const stored = store.add({
        environmentId: input.environmentId,
        anchor: input.anchor,
        anchorBlob: input.anchorBlob,
        createdTargetKey: targetKey(input.target),
        body: input.body,
        authorPerson: input.byPerson === true,
        ...(input.authorThreadId === undefined
          ? {}
          : { authorThreadId: input.authorThreadId }),
      });
      changed(input.environmentId);
      return {
        comment: toComment(stored, {
          placement: {
            kind: "current",
            startLine: stored.startLine,
            endLine: stored.endLine,
          },
        }),
      };
    } catch (error) {
      if (error instanceof CommentLimitError) refuse("conflict", error.message);
      throw error;
    }
  }

  function requireComment(id: string): StoredComment {
    const comment = store.get(id);
    if (comment === undefined) refuse("not_found", `Comment not found: ${id}`);
    return comment;
  }

  async function selectComments(
    input: CommentSelectionInput,
  ): Promise<StoredComment[]> {
    await requireGitEnvironment(bb, input.environmentId);
    const selected = store.select({
      environmentId: input.environmentId,
      ...(input.ids === undefined ? {} : { ids: input.ids }),
      includeSent: input.includeSent ?? false,
      ...(input.path === undefined ? {} : { path: input.path }),
    });
    if (selected.length === 0)
      refuse("conflict", "There are no comments to send.");
    return selected;
  }

  async function requireThreadInEnvironment(
    threadId: string,
    environmentId: string,
  ): Promise<void> {
    const thread = await bb.sdk.threads
      .get({ threadId })
      .catch((error: unknown) => {
        if (error instanceof experimental_BbHttpError && error.status === 404) {
          return refuse("not_found", `Thread not found: ${threadId}`);
        }
        throw error;
      });
    if (thread.environmentId !== environmentId) {
      refuse("invalid", "That thread works in a different environment.");
    }
  }

  async function createBatch(
    input: CommentSelectionInput & { threadId: string },
  ): Promise<{ batch: StoredBatch; label: string; omitted: number }> {
    await requireThreadInEnvironment(input.threadId, input.environmentId);
    const selected = await selectComments(input);
    const included = selected.slice(0, GIT_COMMENT_BATCH_MAX_COMMENTS);
    const omitted = selected.length - included.length;
    const commentIds = included.map((comment) => comment.id);
    const includeSent =
      input.includeSent === true ||
      included.some((comment) => comment.sent !== undefined);
    const existing = store.findUnresolvedBatch({
      environmentId: input.environmentId,
      threadId: input.threadId,
      commentIds,
      includeSent,
    });
    const batch =
      existing ??
      (store.pruneBatches(),
      store.createBatch({
        environmentId: input.environmentId,
        threadId: input.threadId,
        commentIds,
        includeSent,
      }));
    const label = `${included.length} review comment${included.length === 1 ? "" : "s"}`;
    return { batch, label, omitted };
  }

  return {
    environmentTarget,
    async list(environmentId, target, includeResolved, signal) {
      await requireGitEnvironment(bb, environmentId);
      const stored = store.list(environmentId, includeResolved);
      const placements = await placementsFor(environmentId, target, stored, {
        deadlineAt: Date.now() + LIST_PLACEMENT_DEADLINE_MS,
        signal,
      });
      return {
        comments: stored.map((comment) =>
          toComment(
            comment,
            placements.get(comment.id) ?? { placement: { kind: "unknown" } },
          ),
        ),
      };
    },
    async add(input) {
      await requireGitEnvironment(bb, input.environmentId);
      const blobs = blobsFromRevision(input.revision);
      return storeComment({
        environmentId: input.environmentId,
        target: input.target,
        anchor: input.anchor,
        anchorBlob: (input.anchor.side === "new" ? blobs.new : blobs.old) ?? "",
        body: input.body,
        authorThreadId: input.authorThreadId,
        byPerson: input.byPerson,
      });
    },
    async addFromFile(input) {
      await requireGitEnvironment(bb, input.environmentId);
      if (input.endLine < input.startLine) {
        refuse("invalid", "The end line comes before the start line.");
      }
      if (input.endLine - input.startLine + 1 > GIT_COMMENT_MAX_LINES) {
        refuse(
          "invalid",
          `A comment covers at most ${GIT_COMMENT_MAX_LINES} lines.`,
        );
      }
      const current = await currentBlobAndLines(
        input.environmentId,
        input.target,
        input.path,
        input.side,
      );
      if (input.endLine > current.lines.length) {
        refuse(
          "invalid",
          `${input.path} has ${current.lines.length} lines on the ${input.side} side.`,
        );
      }
      const anchor: GitCommentAnchor = {
        path: input.path,
        side: input.side,
        startLine: input.startLine,
        endLine: input.endLine,
        lines: current.lines.slice(input.startLine - 1, input.endLine),
        contextBefore: current.lines.slice(
          Math.max(0, input.startLine - 1 - GIT_COMMENT_CONTEXT_LINES),
          input.startLine - 1,
        ),
        contextAfter: current.lines.slice(
          input.endLine,
          input.endLine + GIT_COMMENT_CONTEXT_LINES,
        ),
      };
      const codeBytes = Buffer.byteLength(
        [...anchor.lines, ...anchor.contextBefore, ...anchor.contextAfter].join(
          "\n",
        ),
      );
      if (codeBytes > GIT_COMMENT_CODE_MAX_BYTES) {
        refuse("invalid", "The commented code is too large.");
      }
      return storeComment({
        environmentId: input.environmentId,
        target: input.target,
        anchor,
        anchorBlob: current.blob ?? "",
        body: input.body,
        authorThreadId: input.authorThreadId,
        byPerson: input.byPerson,
      });
    },
    edit(id, body) {
      const updated = store.edit(id, body);
      if (updated === undefined)
        refuse("not_found", `Comment not found: ${id}`);
      changed(updated.environmentId);
      return { ok: true };
    },
    remove(id) {
      const removed = store.remove(id);
      if (removed === undefined)
        refuse("not_found", `Comment not found: ${id}`);
      changed(removed.environmentId);
      return { ok: true };
    },
    resolve(id, resolution) {
      requireComment(id);
      const updated = store.resolve(id, {
        ...(resolution.note === undefined ? {} : { note: resolution.note }),
        ...(resolution.byThreadId === undefined
          ? {}
          : { byThreadId: resolution.byThreadId }),
      });
      if (updated === undefined)
        refuse("not_found", `Comment not found: ${id}`);
      changed(updated.environmentId);
      return { ok: true };
    },
    reopen(id) {
      requireComment(id);
      const updated = store.reopen(id);
      if (updated === undefined)
        refuse("not_found", `Comment not found: ${id}`);
      changed(updated.environmentId);
      return { ok: true };
    },
    async createBatch(input) {
      const { batch, label, omitted } = await createBatch(input);
      return {
        batchId: batch.id,
        count: batch.commentIds.length,
        omitted,
        label,
      };
    },
    async send(input) {
      const { batch, label, omitted } = await createBatch(input);
      const mentionText = `@${label}`;
      const text =
        input.message === undefined || input.message.trim().length === 0
          ? mentionText
          : `${mentionText}\n\n${input.message}`;
      await bb.sdk.threads.send({
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text,
            mentions: [
              {
                start: 0,
                end: mentionText.length,
                resource: {
                  kind: "plugin",
                  pluginId: bb.pluginId,
                  itemId: `${GIT_COMMENT_MENTION_PROVIDER_ID}:${batch.id}`,
                  label,
                },
              },
            ],
          },
        ],
        mode: "queue-if-active",
      });
      return { batchId: batch.id, count: batch.commentIds.length, omitted };
    },
    async resolveBatchContext(batchId) {
      const batch = store.getBatch(batchId);
      if (batch === undefined) {
        return {
          context:
            "The review comments attached to this message are no longer available. Run bb git comments list to see the open comments.",
        };
      }
      const open = store
        .getMany(batch.commentIds)
        .filter(
          (comment) =>
            comment.environmentId === batch.environmentId &&
            comment.resolution === undefined,
        );
      const comments = batch.includeSent
        ? open
        : open.filter((comment) => comment.sent === undefined);
      if (comments.length === 0) {
        return {
          context: `The ${batch.commentIds.length} review comments attached to this message for environment ${batch.environmentId} were already resolved, deleted or delivered in an earlier message. Nothing to do for them. Run bb git comments list to see what is open.`,
        };
      }
      const target = await environmentTarget(batch.environmentId);
      const placements = await placementsFor(
        batch.environmentId,
        target,
        comments,
        { deadlineAt: Date.now() + BATCH_RESOLVE_DEADLINE_MS },
      );
      const promptComments: PromptComment[] = comments.map((comment) => {
        const resolved = placements.get(comment.id) ?? {
          placement: { kind: "unknown" as const },
        };
        const { placement } = resolved;
        const range =
          placement.kind === "current" || placement.kind === "moved"
            ? placement
            : { startLine: comment.startLine, endLine: comment.endLine };
        return {
          id: comment.id,
          path: resolved.currentPath ?? comment.path,
          side: comment.side,
          startLine: range.startLine,
          endLine: range.endLine,
          lines: comment.lines,
          placement: placement.kind,
          author:
            comment.authorThreadId !== undefined
              ? { threadId: comment.authorThreadId }
              : comment.authorPerson
                ? "user"
                : "unspecified",
          body: comment.body,
        };
      });
      store.markBatchSent(
        batch,
        comments.map((comment) => comment.id),
      );
      changed(batch.environmentId);
      return {
        context: formatReviewCommentsContext({
          environmentId: batch.environmentId,
          comments: promptComments,
        }),
      };
    },
    async forgetDeletedEnvironments(exists) {
      for (const environmentId of store.environmentsWithComments()) {
        if (!(await exists(environmentId)))
          store.forgetEnvironment(environmentId);
      }
      store.pruneBatches();
    },
  };
}
