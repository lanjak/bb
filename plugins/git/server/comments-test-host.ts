import { experimental_BbHttpError, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

type Environment = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["get"]>
>;

export const ENVIRONMENT = {
  id: "env-1",
  name: null,
  projectId: "project-1",
  hostId: "host-1",
  path: "/work/env-1",
  isGitRepo: true,
  isWorktree: true,
  branchName: "feature",
  baseBranch: null,
  defaultBranch: "main",
  mergeBaseBranch: null,
  status: "ready",
  environmentProviderId: "git-worktree",
  lifecycle: { phase: "active", retireAt: null, teardown: null },
  hostLifecycle: "active",
  environmentProviderSelection: null,
  environmentProviderInstanceKey: null,
  managed: true,
  heldBy: null,
  statusMessage: null,
  workspaceProvisionType: "worktree",
} as Environment;

export const ALL = { type: "all", mergeBaseBranch: "main" };
const MERGE_BASE_REF = "abc1234";

interface FileState {
  path: string;
  previousPath?: string;
  newBlob: string;
  content: string;
}

export function lines(...text: string[]): string {
  return `${text.join("\n")}\n`;
}

function revisionOf(file: FileState): string {
  return `100644:0a0a0a:100644:${file.newBlob}`;
}

export async function commentsHost(
  options: { existing?: string[]; threads?: Record<string, string> } = {},
) {
  const existing = options.existing ?? ["env-1", "env-2"];
  const threads = options.threads ?? { "thr-1": "env-1", "thr-2": "env-2" };
  const state = {
    files: new Map<string, FileState>(),
    filesFail: false,
    filesHang: false,
    sent: [] as unknown[],
    reads: [] as string[],
    hangReads: new Set<string>(),
  };
  const fake = createFakePluginHost({
    pluginId: "bb--git",
    sdk: {
      subscribe: () => () => {},
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          if (!existing.includes(environmentId)) {
            throw new experimental_BbHttpError({
              status: 404,
              code: null,
              message: "Environment not found",
              body: null,
            });
          }
          return { ...ENVIRONMENT, id: environmentId };
        },
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const environmentId = threads[threadId];
          if (environmentId === undefined) {
            throw new experimental_BbHttpError({
              status: 404,
              code: null,
              message: "Thread not found",
              body: null,
            });
          }
          return { id: threadId, environmentId };
        },
        send: async (args: unknown) => {
          state.sent.push(args);
          return {};
        },
      },
      files: {
        read: async ({ path }: { path: string }) => {
          const relative = path.replace("/work/env-1/", "");
          state.reads.push(relative);
          if (state.hangReads.has(relative)) {
            return new Promise<never>(() => undefined);
          }
          const file = state.files.get(relative);
          if (file === undefined) {
            throw new experimental_BbHttpError({
              status: 404,
              code: "ENOENT",
              message: "missing",
              body: { code: "ENOENT", message: "missing" },
            });
          }
          return {
            path,
            content: file.content,
            contentEncoding: "utf8",
            sizeBytes: file.content.length,
          };
        },
      },
    },
    experimental_callHostRpc: (call: ExperimentalFakeHostRpcCall) => {
      if (call.method !== "files") {
        throw new Error(`unexpected host call ${call.method}`);
      }
      if (state.filesFail) throw new Error("machine unreachable");
      if (state.filesHang) return new Promise(() => undefined);
      return {
        outcome: "available",
        value: {
          files: [...state.files.values()].map((file) => ({
            path: file.path,
            previousPath: file.previousPath ?? null,
            changeKind:
              file.previousPath === undefined ? "modified" : "renamed",
            additions: 1,
            deletions: 1,
            binary: false,
            origin: "tracked",
            loadMode: "auto",
            revision: revisionOf(file),
          })),
          truncated: false,
          shortstat: "",
          mergeBaseRef: MERGE_BASE_REF,
          initialPatches: [],
        },
      };
    },
  });
  plugin(fake.bb);
  const call = (
    method: string,
    input: Record<string, unknown>,
    controller?: AbortController,
  ) =>
    fake.harness.callRpc(
      method,
      { environmentId: "env-1", ...input },
      controller === undefined ? {} : { signal: controller.signal },
    );
  const rpc = (method: string, input: Record<string, unknown>) =>
    fake.harness.callRpc(method, input);
  const list = async (includeResolved = false) =>
    (
      (await call("comments", { target: ALL, includeResolved })) as {
        comments: Array<Record<string, any>>;
      }
    ).comments;
  const source = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const refreshReads = () =>
    fake.harness.callRpc("refresh", { environmentId: "env-1" });
  const setFile = async (file: Partial<FileState> & { content: string }) => {
    const path = file.path ?? "src/a.ts";
    state.files.set(path, {
      path,
      newBlob: file.newBlob ?? "b1b1b1",
      ...file,
    });
    await refreshReads();
  };
  const clearFiles = async () => {
    state.files.clear();
    await refreshReads();
  };
  const add = async (
    overrides: Record<string, unknown> = {},
    anchor: Record<string, unknown> = {},
  ) => {
    await setFile({ content: lines(...source), newBlob: "b1b1b1" });
    return (
      (await call("addComment", {
        target: ALL,
        revision: "100644:0a0a0a:100644:b1b1b1",
        anchor: {
          path: "src/a.ts",
          side: "new",
          startLine: 3,
          endLine: 4,
          lines: ["gamma", "delta"],
          contextBefore: ["alpha", "beta"],
          contextAfter: ["epsilon", "zeta"],
          ...anchor,
        },
        body: "Why not cache this?",
        ...overrides,
      })) as { comment: Record<string, any> }
    ).comment;
  };
  return { fake, state, call, rpc, list, add, setFile, clearFiles, source };
}
