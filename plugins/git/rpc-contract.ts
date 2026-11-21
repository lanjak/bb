import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitBranchNameSchema, isValidGitBranchName } from "@bb/domain";
import {
  GIT_DIFF_MAX_DIFF_BYTES,
  GIT_DIFF_MAX_FILE_LIST_BYTES,
  GIT_PATCHES_MAX_KEYS,
  GIT_STATUS_MAX_KEYS,
  GIT_COMMENT_BODY_MAX,
  GIT_COMMENT_NOTE_MAX,
  GIT_VIEWED_MAX_PATHS,
  gitCommentAnchorSchema,
  gitCommentIdSchema,
  gitCommentBatchIdSchema,
  gitCommentSchema,
  gitCommentSelectionSchema,
  gitCommentsTag,
  gitDiffResultSchema,
  gitFileSideQuerySchema,
  gitFileSideResultSchema,
  gitFilesResultSchema,
  gitFilesTag,
  gitPatchResultSchema,
  gitRefsTag,
  gitStatusResultSchema,
  gitStatusRowSchema,
  gitStatusTag,
  gitViewedFileSchema,
  gitViewedTag,
  workspaceDiffTargetSchema,
} from "./contract.js";
import {
  BRANCH_LIST_LIMIT_MAX,
  BRANCH_LIST_QUERY_MAX_LENGTH,
  gitBranchOptionsSchema,
} from "bb-environment-provider-host/git-types";

const gitDiffQuerySchema = workspaceDiffTargetSchema.refine(
  (target) =>
    !("mergeBaseBranch" in target) ||
    isValidGitBranchName(target.mergeBaseBranch),
  { message: "Invalid git branch name" },
);

const environmentInputSchema = z
  .object({ environmentId: z.string().min(1) })
  .strict();

export const gitRpcContract = defineRpcContract({
  status: {
    experimental_description:
      "Git status of each environment's workspace, keyed by environment id. Branch comparison uses the environment's merge base.",
    input: z
      .object({
        keys: z.array(z.string().min(1)).min(1).max(GIT_STATUS_MAX_KEYS),
      })
      .strict(),
    output: z.record(z.string(), gitStatusRowSchema),
    keyTags: (key) => [gitStatusTag(key)],
  },
  workspaceStatus: {
    experimental_description:
      "Git status of one environment's workspace, compared with mergeBaseBranch when given.",
    input: environmentInputSchema
      .extend({ mergeBaseBranch: gitBranchNameSchema.optional() })
      .strict(),
    output: gitStatusResultSchema,
    tags: ({ environmentId }) => [gitStatusTag(environmentId)],
  },
  diff: {
    experimental_description:
      "The unified diff, file list and shortstat for one environment and target.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        maxDiffBytes: z
          .number()
          .int()
          .min(1)
          .max(GIT_DIFF_MAX_DIFF_BYTES)
          .optional(),
        maxFileListBytes: z
          .number()
          .int()
          .min(1)
          .max(GIT_DIFF_MAX_FILE_LIST_BYTES)
          .optional(),
      })
      .strict(),
    output: gitDiffResultSchema,
    tags: ({ environmentId }) => [gitFilesTag(environmentId)],
  },
  files: {
    experimental_description:
      "Changed files with per-file line counts for one environment and target, with patches for small files.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        ignoreWhitespace: z.boolean(),
      })
      .strict(),
    output: gitFilesResultSchema,
    tags: ({ environmentId }) => [gitFilesTag(environmentId)],
  },
  patches: {
    experimental_description:
      "One file's patch per key. Build keys with the contract's gitPatchKey from a files entry's path and revision.",
    input: z
      .object({
        keys: z.array(z.string().min(1)).min(1).max(GIT_PATCHES_MAX_KEYS),
      })
      .strict(),
    output: z.record(z.string(), gitPatchResultSchema),
    keyTags: () => [],
  },
  fileSide: {
    experimental_description:
      "The old or new side of one changed file, for expanding diff context.",
    input: environmentInputSchema
      .extend({ query: gitFileSideQuerySchema })
      .strict(),
    output: gitFileSideResultSchema,
  },
  branches: {
    experimental_description:
      "Local and remote branches to compare an environment against.",
    input: environmentInputSchema
      .extend({
        query: z.string().max(BRANCH_LIST_QUERY_MAX_LENGTH).optional(),
        limit: z.number().int().min(1).max(BRANCH_LIST_LIMIT_MAX).optional(),
        selectedBranch: gitBranchNameSchema.optional(),
      })
      .strict(),
    output: gitBranchOptionsSchema,
    tags: ({ environmentId }) => [gitRefsTag(environmentId)],
  },
  fetchRemoteBranches: {
    experimental_description:
      "Start a background fetch of origin, or of the only remote when there is no origin, for an environment's repository, at most once every 30 seconds per repository. Refreshed branches arrive through branches.",
    input: environmentInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  viewed: {
    experimental_description:
      "Files marked Viewed for an environment and diff target.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        paths: z
          .array(z.string().min(1).max(4096))
          .max(GIT_VIEWED_MAX_PATHS)
          .optional(),
      })
      .strict(),
    output: z.object({ files: z.array(gitViewedFileSchema) }).strict(),
    tags: ({ environmentId }) => [gitViewedTag(environmentId)],
  },
  markViewed: {
    experimental_description:
      "Mark a file Viewed at a revision returned by files.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        path: z.string().min(1).max(4096),
        revision: z.string().min(1).max(1024),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  clearViewed: {
    experimental_description:
      "Clear one file's Viewed mark, or every mark for the target.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        path: z.string().min(1).max(4096).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  comments: {
    experimental_description:
      "Review comments saved on diff lines for an environment, with where each one sits in the given diff target now (current, moved, outdated, not_in_diff or unknown). Resolved comments are included only when asked for.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        includeResolved: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ comments: z.array(gitCommentSchema) }).strict(),
    tags: ({ environmentId }) => [
      gitCommentsTag(environmentId),
      gitFilesTag(environmentId),
    ],
  },
  addComment: {
    experimental_description:
      "Save a review comment on diff lines. Pass the revision of the file entry the lines were read from so the comment can follow the code through later edits. The comment's author is what the caller states and the server cannot verify it: authorThreadId marks an agent's comment, byPerson marks a person's, and a comment with neither is shown as unspecified.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        revision: z.string().min(1).max(1024),
        anchor: gitCommentAnchorSchema,
        body: z.string().trim().min(1).max(GIT_COMMENT_BODY_MAX),
        authorThreadId: z.string().min(1).optional(),
        byPerson: z.literal(true).optional(),
      })
      .strict(),
    output: z.object({ comment: gitCommentSchema }).strict(),
  },
  editComment: {
    experimental_description:
      "Change a comment's text. An edited comment is no longer marked sent.",
    input: z
      .object({
        id: gitCommentIdSchema,
        body: z.string().trim().min(1).max(GIT_COMMENT_BODY_MAX),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  deleteComment: {
    experimental_description: "Delete a review comment.",
    input: z.object({ id: gitCommentIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  resolveComment: {
    experimental_description:
      "Mark a review comment resolved, with a note about what changed or why nothing did. Pass resolvedByThreadId when an agent thread resolves it.",
    input: z
      .object({
        id: gitCommentIdSchema,
        note: z.string().trim().min(1).max(GIT_COMMENT_NOTE_MAX).optional(),
        resolvedByThreadId: z.string().min(1).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  reopenComment: {
    experimental_description:
      "Reopen a resolved comment. It becomes unsent again.",
    input: z.object({ id: gitCommentIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  createCommentBatch: {
    experimental_description:
      "Group open comments into a batch for a thread in the same environment. Insert the returned batchId as a mention chip (provider review-comments) in that thread's composer; the comments reach the agent when the message is sent. By default every open comment that was not sent yet is included, up to 200; omitted counts the rest. The same selection for the same thread returns the same batch, and a comment that an earlier chip already delivered is not repeated unless includeSent is set.",
    input: environmentInputSchema
      .extend({
        threadId: z.string().min(1),
        ...gitCommentSelectionSchema.shape,
      })
      .strict(),
    output: z
      .object({
        batchId: gitCommentBatchIdSchema,
        count: z.number().int().min(1),
        omitted: z.number().int().min(0),
        label: z.string().min(1),
      })
      .strict(),
  },
  sendComments: {
    experimental_description:
      "Send open comments to a thread in the same environment as one message, without a composer. The agent gets the same context as a composer chip.",
    input: environmentInputSchema
      .extend({
        threadId: z.string().min(1),
        message: z.string().max(GIT_COMMENT_BODY_MAX).optional(),
        ...gitCommentSelectionSchema.shape,
      })
      .strict(),
    output: z
      .object({
        batchId: gitCommentBatchIdSchema,
        count: z.number().int().min(1),
        omitted: z.number().int().min(0),
      })
      .strict(),
  },
  setMergeBase: {
    experimental_description:
      "Compare an environment against a branch, or null for its default.",
    input: environmentInputSchema
      .extend({ mergeBaseBranch: gitBranchNameSchema.nullable() })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }).strict(),
      z
        .object({
          ok: z.literal(false),
          environmentStatus: z.enum([
            "creating",
            "provisioning",
            "ready",
            "error",
            "destroyed",
          ]),
        })
        .strict(),
    ]),
  },
  refresh: {
    experimental_description:
      "Drop an environment's cached git reads and refresh every view of them, for example after a commit.",
    input: environmentInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
