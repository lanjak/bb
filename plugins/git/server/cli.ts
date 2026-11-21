import { isValidGitBranchName } from "@bb/domain";
import {
  cliCommand,
  defineCli,
  experimental_PluginRpcRefusal,
  PluginCliError,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import type {
  GitComment,
  GitFileSideQuery,
  WorkspaceDiffTarget,
} from "../contract.js";
import type { GitCommentsService } from "./comment-service.js";
import type { GitReads } from "./reads.js";
import type { GitViewed } from "./viewed.js";
import { BRANCH_LIST_LIMIT_MAX } from "bb-environment-provider-host/git-types";

const JSON_OPTION = {
  type: "boolean",
  description: "Print machine-readable JSON output",
} as const;

const ENVIRONMENT_POSITIONAL = [
  {
    name: "environment-id",
    description: "Environment whose workspace to read",
    required: true,
  },
] as const;

const TARGET_OPTIONS = {
  target: {
    type: "enum",
    values: ["uncommitted", "branch_committed", "all", "commit"],
    required: true,
    description: "Diff target: uncommitted, branch_committed, all, or commit",
  },
  "merge-base-branch": {
    type: "string",
    description: "Branch-based target base",
  },
  sha: { type: "string", description: "Commit target SHA" },
} as const;

const DEFAULT_BRANCH_LIMIT = 50;

function print(...values: (string | null | undefined | false)[]) {
  return {
    exitCode: 0,
    stdout: values
      .filter((value): value is string => typeof value === "string")
      .map((value) => `${value}\n`)
      .join(""),
  };
}

function json(value: unknown) {
  return print(JSON.stringify(value, null, 2));
}

function fail(message: string): never {
  throw new PluginCliError(message, { code: "invalid_value" });
}

function branchName(value: string): string {
  if (!isValidGitBranchName(value)) fail(`Invalid git branch name: ${value}`);
  return value;
}

function withCoreErrors<Input extends { options: object }>(
  run: (input: Input, ctx: PluginCliContext) => Promise<PluginCliResult>,
) {
  return async (
    input: Input,
    ctx: PluginCliContext,
  ): Promise<PluginCliResult> => {
    try {
      return await run(input, ctx);
    } catch (error) {
      if (!(error instanceof PluginCliError)) throw error;
      const hint = error.hint === undefined ? {} : { hint: error.hint };
      const envelope = {
        ok: false,
        error: { code: error.code, message: error.message, ...hint },
      };
      const wantsJson = "json" in input.options && input.options.json === true;
      return {
        exitCode: error.exitCode,
        stderr: `Error: ${error.message}\n${error.hint === undefined ? "" : `${error.hint}\n`}`,
        ...(wantsJson
          ? { stdout: `${JSON.stringify(envelope, null, 2)}\n` }
          : {}),
      };
    }
  };
}

function buildTarget(options: {
  target: "uncommitted" | "branch_committed" | "all" | "commit";
  "merge-base-branch"?: string | undefined;
  sha?: string | undefined;
}): WorkspaceDiffTarget {
  const mergeBaseBranch = options["merge-base-branch"];
  switch (options.target) {
    case "uncommitted":
      if (mergeBaseBranch !== undefined || options.sha !== undefined) {
        fail(
          "--target uncommitted cannot be combined with --merge-base-branch or --sha.",
        );
      }
      return { type: "uncommitted" };
    case "branch_committed":
    case "all":
      if (!mergeBaseBranch) {
        fail(
          `--merge-base-branch is required when --target ${options.target} is used.`,
        );
      }
      if (options.sha !== undefined) {
        fail(`--target ${options.target} cannot be combined with --sha.`);
      }
      return {
        type: options.target,
        mergeBaseBranch: branchName(mergeBaseBranch),
      };
    case "commit":
      if (!options.sha) fail("--sha is required when --target commit is used.");
      if (mergeBaseBranch !== undefined) {
        fail("--target commit cannot be combined with --merge-base-branch.");
      }
      return { type: "commit", sha: options.sha };
  }
}

function buildFileSideQuery(options: {
  target: "uncommitted" | "branch_committed" | "all" | "commit";
  path: string;
  side: "old" | "new";
  "merge-base-ref"?: string | undefined;
  sha?: string | undefined;
}): GitFileSideQuery {
  const common = { path: options.path, side: options.side };
  const mergeBaseRef = options["merge-base-ref"];
  switch (options.target) {
    case "uncommitted":
      if (mergeBaseRef !== undefined || options.sha !== undefined) {
        fail(
          "--target uncommitted cannot be combined with --merge-base-ref or --sha.",
        );
      }
      return { ...common, target: "uncommitted" };
    case "branch_committed":
    case "all":
      if (!mergeBaseRef) {
        fail(
          `--merge-base-ref is required when --target ${options.target} is used.`,
        );
      }
      if (options.sha !== undefined) {
        fail(`--target ${options.target} cannot be combined with --sha.`);
      }
      return { ...common, target: options.target, mergeBaseRef };
    case "commit":
      if (!options.sha) fail("--sha is required when --target commit is used.");
      if (mergeBaseRef !== undefined) {
        fail("--target commit cannot be combined with --merge-base-ref.");
      }
      return { ...common, target: "commit", sha: options.sha };
  }
}

function unavailableMessage(
  result:
    | { outcome: "not_applicable"; message: string }
    | { outcome: "unavailable"; failure: { message: string } },
): string {
  return result.outcome === "not_applicable"
    ? result.message
    : result.failure.message;
}

const REFUSAL_CLI_ERRORS: Readonly<
  Partial<
    Record<
      experimental_PluginRpcRefusal["code"],
      { code: string; message: string }
    >
  >
> = {
  not_found: {
    code: "environment_not_found",
    message: "Environment not found",
  },
  conflict: {
    code: "environment_not_ready",
    message: "Environment unavailable",
  },
};

function httpErrorBody(
  error: unknown,
): { code: string; message: string } | null {
  if (typeof error !== "object" || error === null || !("body" in error)) {
    return null;
  }
  const body = error.body;
  return typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string" &&
    "message" in body &&
    typeof body.message === "string"
    ? { code: body.code, message: body.message }
    : null;
}

function toCliError(error: unknown): never {
  if (error instanceof experimental_PluginRpcRefusal) {
    const mapped = REFUSAL_CLI_ERRORS[error.code];
    throw new PluginCliError(mapped?.message ?? error.message, {
      code: mapped?.code ?? error.code,
    });
  }
  const body = httpErrorBody(error);
  if (body !== null)
    throw new PluginCliError(body.message, { code: body.code });
  throw error;
}

function guarded<Args extends unknown[], Result>(
  read: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => read(...args).catch(toCliError);
}

const OPTIONAL_TARGET_OPTIONS = {
  ...TARGET_OPTIONS,
  target: { ...TARGET_OPTIONS.target, required: false },
} as const;

function guardedComments<Args extends unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) =>
    run(...args).catch((error: unknown) => {
      if (error instanceof experimental_PluginRpcRefusal) {
        throw new PluginCliError(error.message, { code: error.code });
      }
      return toCliError(error);
    });
}

function parseLineRange(value: string): { start: number; end: number } {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value);
  if (match === null) fail(`Invalid --line "${value}". Use N or N-M.`);
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) fail(`Invalid --line "${value}".`);
  return { start, end };
}

function describePlacement(comment: GitComment): string {
  const { placement } = comment;
  switch (placement.kind) {
    case "current":
      return `lines ${placement.startLine}-${placement.endLine}`;
    case "moved":
      return `moved to lines ${placement.startLine}-${placement.endLine} (was ${placement.fromStartLine})`;
    case "outdated":
      return "outdated: the commented code changed";
    case "not_in_diff":
      return "file no longer differs from the merge base";
    case "unknown":
      return "position unknown";
  }
}

function describeComment(comment: GitComment): string[] {
  const author =
    comment.author.kind === "thread"
      ? `thread:${comment.author.threadId}`
      : comment.author.kind;
  const path = comment.currentPath ?? comment.path;
  const side = comment.side === "old" ? " [removed code]" : "";
  const resolution = comment.resolution;
  return [
    `${comment.id}  ${comment.state}  ${path}${side}  ${describePlacement(comment)}  by ${author}`,
    ...comment.body.split("\n").map((line) => `  ${line}`),
    ...(resolution?.note === undefined
      ? []
      : [`  Resolved: ${resolution.note}`]),
  ];
}

export function createGitCli(
  gitReads: GitReads,
  gitViewed: GitViewed,
  gitComments: GitCommentsService,
  threadEnvironmentId: (threadId: string) => Promise<string | null>,
) {
  const comments = {
    environmentTarget: guardedComments(gitComments.environmentTarget),
    list: guardedComments(gitComments.list),
    addFromFile: guardedComments(gitComments.addFromFile),
    edit: guardedComments(async (id: string, body: string) =>
      gitComments.edit(id, body),
    ),
    remove: guardedComments(async (id: string) => gitComments.remove(id)),
    resolve: guardedComments(
      async (
        id: string,
        resolution: {
          note?: string | undefined;
          byThreadId?: string | undefined;
        },
      ) => gitComments.resolve(id, resolution),
    ),
    reopen: guardedComments(async (id: string) => gitComments.reopen(id)),
    send: guardedComments(gitComments.send),
  };
  async function commentTarget(
    environmentId: string,
    options: {
      target?:
        | "uncommitted"
        | "branch_committed"
        | "all"
        | "commit"
        | undefined;
      "merge-base-branch"?: string | undefined;
      sha?: string | undefined;
    },
  ): Promise<WorkspaceDiffTarget> {
    if (options.target === undefined) {
      if (
        options["merge-base-branch"] !== undefined ||
        options.sha !== undefined
      ) {
        fail("--merge-base-branch and --sha need --target.");
      }
      return comments.environmentTarget(environmentId);
    }
    return buildTarget({ ...options, target: options.target });
  }
  async function environmentOf(
    positional: string | undefined,
    threadId: string | undefined,
  ): Promise<string> {
    if (positional !== undefined) return positional;
    if (threadId === undefined) {
      fail("Provide an environment id, or run this from an agent thread.");
    }
    const environmentId = await threadEnvironmentId(threadId).catch(
      (error: unknown) => toCliError(error),
    );
    if (environmentId === null) {
      fail("This thread has no environment. Provide an environment id.");
    }
    return environmentId;
  }

  const reads = {
    status: guarded(gitReads.status),
    diff: guarded(gitReads.diff),
    files: guarded(gitReads.files),
    patches: guarded(gitReads.patches),
    fileSide: guarded(gitReads.fileSide),
    branches: guarded(gitReads.branches),
  };
  const viewed = {
    list: guarded(gitViewed.list),
    mark: guarded(gitViewed.mark),
    clear: guarded(gitViewed.clear),
  };
  async function currentRevision(
    environmentId: string,
    target: WorkspaceDiffTarget,
    path: string,
  ): Promise<string> {
    const result = await reads.files(environmentId, target, false, "bypass");
    if (result.outcome !== "available") {
      throw new PluginCliError(
        `Diff files unavailable: ${unavailableMessage(result)}`,
      );
    }
    const file = result.files.find((entry) => entry.path === path);
    if (file === undefined) {
      throw new PluginCliError(`${path} is not a changed file in this diff.`);
    }
    return file.revision;
  }

  return defineCli({
    name: "git",
    summary: "Read an environment's git status, changed files and diffs",
    description:
      "Runs git on the environment's machine. Mark files Viewed the way the Diff tab does.",
    commands: {
      status: cliCommand({
        summary: "Show an environment's workspace status",
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          "merge-base-branch": {
            type: "string",
            description: "Include merge-base status",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const mergeBaseBranch = options["merge-base-branch"];
          const result = await reads.status(
            positionals["environment-id"],
            {
              kind: "explicit",
              ...(mergeBaseBranch === undefined
                ? {}
                : { branch: branchName(mergeBaseBranch) }),
            },
            "bypass",
          );
          if (options.json) return json(result);
          if (result.outcome !== "available") {
            return print(`Status unavailable: ${unavailableMessage(result)}`);
          }
          const status = result.workspace;
          const mergeBase = status.mergeBase;
          return print(
            `State: ${status.workingTree.state}`,
            `Branch: ${status.branch.currentBranch ?? "(detached)"}`,
            `Default branch: ${status.branch.defaultBranch}`,
            `Changed files: ${status.workingTree.fileCount}`,
            status.workingTree.lineStatsComplete
              ? `Insertions: +${status.workingTree.insertions}`
              : "Line stats: unavailable for untracked files",
            status.workingTree.lineStatsComplete &&
              `Deletions: -${status.workingTree.deletions}`,
            mergeBase && `Merge base: ${mergeBase.mergeBaseBranch}`,
            mergeBase &&
              !mergeBase.squashMergeCheckComplete &&
              "Squash-merge check incomplete; counts may include already-merged commits.",
            mergeBase && `Ahead: ${mergeBase.aheadCount}`,
            mergeBase && `Behind: ${mergeBase.behindCount}`,
          );
        }),
      }),
      branches: cliCommand({
        summary: "List branches available in an environment",
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          query: { type: "string", description: "Branch-name filter" },
          limit: {
            type: "integer",
            min: 1,
            max: BRANCH_LIST_LIMIT_MAX,
            description: "Maximum local and remote branches",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          await gitReads
            .fetchRemoteBranches(positionals["environment-id"])
            .catch(() => undefined);
          const result = await reads.branches({
            environmentId: positionals["environment-id"],
            limit: options.limit ?? DEFAULT_BRANCH_LIMIT,
            ...(options.query === undefined ? {} : { query: options.query }),
          });
          if (options.json) return json(result);
          return print(
            "Local branches:",
            ...result.branches.map((branch) => `  ${branch}`),
            result.branches.length === 0 && "  (none)",
            result.branchesTruncated && "  (truncated)",
            "Remote branches:",
            ...result.remoteBranches.map((branch) => `  ${branch}`),
            result.remoteBranches.length === 0 && "  (none)",
            result.remoteBranchesTruncated && "  (truncated)",
          );
        }),
      }),
      diff: cliCommand({
        summary: "Show an environment's git diff",
        positionals: ENVIRONMENT_POSITIONAL,
        options: { ...TARGET_OPTIONS, json: JSON_OPTION },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await reads.diff(
            positionals["environment-id"],
            buildTarget(options),
          );
          if (options.json) return json(result);
          if (result.outcome !== "available") {
            return print(`Diff unavailable: ${unavailableMessage(result)}`);
          }
          const { diff } = result;
          return print(
            diff.files.trim().length > 0 && diff.files.trimEnd(),
            diff.shortstat.trim().length > 0 && diff.shortstat.trim(),
            diff.diff.length > 0 && diff.diff,
            diff.truncated && "(diff truncated)",
          );
        }),
      }),
      files: cliCommand({
        summary: "List changed files in an environment",
        aliases: ["diff-files"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          ...TARGET_OPTIONS,
          "ignore-whitespace": {
            type: "boolean",
            description: "Hide whitespace-only changes (git -w)",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await reads.files(
            positionals["environment-id"],
            buildTarget(options),
            options["ignore-whitespace"],
            "bypass",
          );
          if (options.json) {
            return json(
              result.outcome === "available"
                ? {
                    outcome: result.outcome,
                    files: result.files,
                    shortstat: result.shortstat,
                    mergeBaseRef: result.mergeBaseRef,
                    initialPatches: result.initialPatches,
                    truncated: result.truncated,
                  }
                : result,
            );
          }
          if (result.outcome !== "available") {
            return print(
              `Diff files unavailable: ${unavailableMessage(result)}`,
            );
          }
          return print(
            ...result.files.map((file) => {
              const path = file.previousPath
                ? `${file.previousPath} -> ${file.path}`
                : file.path;
              const stats = file.binary
                ? "binary"
                : `+${file.additions} -${file.deletions}`;
              return `${file.changeKind}\t${stats}\t${file.origin}\t${file.loadMode}\t${path}`;
            }),
            result.shortstat.trim().length > 0 && result.shortstat.trim(),
            result.truncated && "(additional changed files omitted)",
          );
        }),
      }),
      file: cliCommand({
        summary: "Read one side of a changed environment file",
        aliases: ["diff-file"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          target: TARGET_OPTIONS.target,
          path: {
            type: "string",
            required: true,
            description: "Repository-relative file path",
          },
          side: {
            type: "enum",
            values: ["old", "new"],
            required: true,
            description: "File side: old or new",
          },
          "merge-base-ref": {
            type: "string",
            description: "Resolved merge-base SHA",
          },
          sha: TARGET_OPTIONS.sha,
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const side = await reads.fileSide(
            positionals["environment-id"],
            buildFileSideQuery(options),
          );
          if (side.outcome === "unavailable") {
            throw new PluginCliError(side.message, { code: side.code });
          }
          const result = side.file;
          if (options.json) return json(result);
          if (result.contentEncoding === "base64") {
            return print(
              `Binary file: ${result.path}`,
              `Encoding: ${result.contentEncoding}`,
              `Size: ${result.sizeBytes} bytes`,
              result.mimeType && `MIME type: ${result.mimeType}`,
              result.content,
            );
          }
          return print(result.content);
        }),
      }),
      patch: cliCommand({
        summary: "Fetch patches for selected changed files",
        aliases: ["diff-patch"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          ...TARGET_OPTIONS,
          path: {
            type: "string",
            repeatable: true,
            description: "Changed file path (repeatable)",
          },
          "ignore-whitespace": {
            type: "boolean",
            description: "Hide whitespace-only changes (git -w)",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          if (options.path.length === 0) fail("Provide at least one --path.");
          const result = await reads.patches(
            positionals["environment-id"],
            buildTarget(options),
            options["ignore-whitespace"],
            options.path,
            "bypass",
          );
          if (options.json) return json(result);
          if (result.outcome !== "available") {
            return print(
              `Diff patches unavailable: ${unavailableMessage(result)}`,
            );
          }
          return print(
            ...result.patches.flatMap((patch) => [
              `File: ${patch.path}`,
              patch.patch,
              patch.truncated ? "(patch truncated)" : null,
            ]),
          );
        }),
      }),
      "comments list": cliCommand({
        summary: "List review comments saved on an environment's diff",
        description:
          "Shows open comments with their current lines. Comments follow the code through edits: placement says current, moved, outdated, or that the file no longer differs from the merge base. Defaults to the calling thread's environment and the diff against its merge base.",
        positionals: [
          {
            name: "environment-id",
            description: "Environment (default: the calling thread's)",
          },
        ],
        options: {
          ...OPTIONAL_TARGET_OPTIONS,
          all: {
            type: "boolean",
            description: "Include resolved comments",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }, ctx) => {
          const environmentId = await environmentOf(
            positionals["environment-id"],
            ctx.threadId,
          );
          const target = await commentTarget(environmentId, options);
          const result = await comments.list(
            environmentId,
            target,
            options.all,
          );
          if (options.json) return json(result);
          if (result.comments.length === 0) {
            return print(options.all ? "No comments." : "No open comments.");
          }
          return print(...result.comments.flatMap(describeComment));
        }),
      }),
      "comments add": cliCommand({
        summary: "Save a review comment on diff lines",
        description:
          "Reads the lines from the file so the comment is anchored the way a comment made in the Diff tab is. --line is N or N-M, on the new file by default; --side old comments on removed code.",
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          ...OPTIONAL_TARGET_OPTIONS,
          path: {
            type: "string",
            required: true,
            description: "Repository-relative path of a changed file",
          },
          line: {
            type: "string",
            required: true,
            description: "Line N or range N-M, at most 50 lines",
          },
          side: {
            type: "enum",
            values: ["new", "old"],
            default: "new",
            description: "File side: new (default) or old (removed code)",
          },
          body: {
            type: "string",
            required: true,
            description: "Comment text",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }, ctx) => {
          const environmentId = positionals["environment-id"];
          const range = parseLineRange(options.line);
          const result = await comments.addFromFile({
            environmentId,
            target: await commentTarget(environmentId, options),
            path: options.path,
            side: options.side,
            startLine: range.start,
            endLine: range.end,
            body: options.body,
            authorThreadId: ctx.threadId,
            byPerson: ctx.threadId === undefined ? true : undefined,
          });
          return options.json
            ? json(result)
            : print(`Saved comment ${result.comment.id}`);
        }),
      }),
      "comments edit": cliCommand({
        summary: "Change a comment's text",
        positionals: [
          { name: "comment-id", description: "Comment id", required: true },
        ],
        options: {
          body: { type: "string", required: true, description: "New text" },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await comments.edit(
            positionals["comment-id"],
            options.body,
          );
          return options.json ? json(result) : print("Comment updated.");
        }),
      }),
      "comments delete": cliCommand({
        summary: "Delete a comment",
        positionals: [
          { name: "comment-id", description: "Comment id", required: true },
        ],
        options: { json: JSON_OPTION },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await comments.remove(positionals["comment-id"]);
          return options.json ? json(result) : print("Comment deleted.");
        }),
      }),
      "comments resolve": cliCommand({
        summary: "Mark a comment resolved, with a note",
        description:
          "Run this after addressing a comment, with a note that says what changed, or why the code stays as it is.",
        positionals: [
          { name: "comment-id", description: "Comment id", required: true },
        ],
        options: {
          note: {
            type: "string",
            description: "What changed, or why nothing did",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }, ctx) => {
          const result = await comments.resolve(positionals["comment-id"], {
            note: options.note,
            byThreadId: ctx.threadId,
          });
          return options.json ? json(result) : print("Comment resolved.");
        }),
      }),
      "comments reopen": cliCommand({
        summary: "Reopen a resolved comment",
        positionals: [
          { name: "comment-id", description: "Comment id", required: true },
        ],
        options: { json: JSON_OPTION },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await comments.reopen(positionals["comment-id"]);
          return options.json ? json(result) : print("Comment reopened.");
        }),
      }),
      "comments send": cliCommand({
        summary: "Send open comments to a thread as one message",
        description:
          "The thread must work in the same environment. The agent receives each comment with its current lines and the command that resolves it. By default every open comment that was not sent yet goes.",
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          thread: {
            type: "string",
            required: true,
            description: "Thread that receives the comments",
          },
          id: {
            type: "string",
            repeatable: true,
            description: "Send only this comment (repeatable)",
          },
          "include-sent": {
            type: "boolean",
            description: "Include comments that were already sent",
          },
          path: {
            type: "string",
            description: "Send only comments on this file",
          },
          message: {
            type: "string",
            description: "Text to add after the comments",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await comments.send({
            environmentId: positionals["environment-id"],
            threadId: options.thread,
            ids: options.id.length > 0 ? options.id : undefined,
            includeSent: options["include-sent"],
            path: options.path,
            message: options.message,
          });
          return options.json
            ? json(result)
            : print(
                `Sent ${result.count} comments to ${options.thread}.`,
                result.omitted > 0 &&
                  `${result.omitted} more were not included (a message carries at most 200); run the command again to send them.`,
              );
        }),
      }),
      "viewed list": cliCommand({
        summary: "List files marked Viewed",
        aliases: ["diff-viewed list"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          ...TARGET_OPTIONS,
          path: {
            type: "string",
            repeatable: true,
            description: "Limit to a changed path; repeat up to 500 times",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await viewed.list(
            positionals["environment-id"],
            buildTarget(options),
            options.path.length > 0 ? options.path : undefined,
          );
          if (options.json) return json(result);
          if (result.files.length === 0)
            return print("No files marked Viewed.");
          return print(
            ...result.files.map((file) => `${file.revision}\t${file.path}`),
          );
        }),
      }),
      "viewed mark": cliCommand({
        summary: "Mark a changed file Viewed at its current revision",
        aliases: ["diff-viewed mark"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          ...TARGET_OPTIONS,
          path: {
            type: "string",
            required: true,
            description: "Changed file path",
          },
          revision: {
            type: "string",
            description:
              "Revision to mark (default: the file's current revision from files)",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const environmentId = positionals["environment-id"];
          const target = buildTarget(options);
          const revision =
            options.revision ??
            (await currentRevision(environmentId, target, options.path));
          const result = await viewed.mark(
            environmentId,
            target,
            options.path,
            revision,
          );
          return options.json ? json(result) : print("Viewed state updated.");
        }),
      }),
      "viewed unmark": cliCommand({
        summary: "Clear Viewed for one file",
        aliases: ["diff-viewed unmark"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: {
          ...TARGET_OPTIONS,
          path: {
            type: "string",
            required: true,
            description: "Changed file path",
          },
          json: JSON_OPTION,
        },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await viewed.clear(
            positionals["environment-id"],
            buildTarget(options),
            options.path,
          );
          return options.json ? json(result) : print("Viewed state updated.");
        }),
      }),
      "viewed clear": cliCommand({
        summary: "Clear Viewed for every file in the diff target",
        aliases: ["diff-viewed clear"],
        positionals: ENVIRONMENT_POSITIONAL,
        options: { ...TARGET_OPTIONS, json: JSON_OPTION },
        run: withCoreErrors(async ({ positionals, options }) => {
          const result = await viewed.clear(
            positionals["environment-id"],
            buildTarget(options),
            undefined,
          );
          return options.json ? json(result) : print("Viewed state updated.");
        }),
      }),
    },
  });
}
