import { useMemo } from "react";
import { toast } from "sonner";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import type { GitComment, WorkspaceDiffTarget } from "../../contract.js";
import { gitRpcContract } from "../../rpc-contract.js";

const EMPTY_COMMENTS: readonly GitComment[] = [];

export function useGitComments(args: {
  environmentId: string;
  target: WorkspaceDiffTarget | undefined;
  enabled: boolean;
}): { comments: readonly GitComment[]; isLoaded: boolean } {
  const { data } = useRpcQuery({
    contract: gitRpcContract,
    method: "comments",
    input: {
      environmentId: args.environmentId,
      target: args.target ?? { type: "uncommitted" },
      includeResolved: true,
    },
    enabled: args.enabled && args.target !== undefined,
  });
  return {
    comments: data?.comments ?? EMPTY_COMMENTS,
    isLoaded: data !== undefined,
  };
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

export interface CommentActions {
  add: (
    input: Parameters<ReturnType<typeof useAddComment>["mutate"]>[0],
  ) => Promise<boolean>;
  edit: (id: string, body: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resolve: (id: string) => Promise<boolean>;
  reopen: (id: string) => Promise<boolean>;
  createBatch: (
    input: Parameters<ReturnType<typeof useCreateBatch>["mutate"]>[0],
  ) => Promise<{
    batchId: string;
    label: string;
    count: number;
    omitted: number;
  } | null>;
}

function useAddComment() {
  return useRpcMutation({ contract: gitRpcContract, method: "addComment" });
}

function useCreateBatch() {
  return useRpcMutation({
    contract: gitRpcContract,
    method: "createCommentBatch",
  });
}

export function useCommentActions(): CommentActions {
  const addComment = useAddComment();
  const editComment = useRpcMutation({
    contract: gitRpcContract,
    method: "editComment",
  });
  const deleteComment = useRpcMutation({
    contract: gitRpcContract,
    method: "deleteComment",
  });
  const resolveComment = useRpcMutation({
    contract: gitRpcContract,
    method: "resolveComment",
  });
  const reopenComment = useRpcMutation({
    contract: gitRpcContract,
    method: "reopenComment",
  });
  const createBatch = useCreateBatch();
  const { mutate: add } = addComment;
  const { mutate: edit } = editComment;
  const { mutate: remove } = deleteComment;
  const { mutate: resolve } = resolveComment;
  const { mutate: reopen } = reopenComment;
  const { mutate: batch } = createBatch;

  return useMemo<CommentActions>(() => {
    async function attempt(
      work: () => Promise<unknown>,
      fallback: string,
    ): Promise<boolean> {
      try {
        await work();
        return true;
      } catch (error) {
        toast.error(failureMessage(error, fallback));
        return false;
      }
    }
    return {
      add: (input) => attempt(() => add(input), "Could not save the comment."),
      edit: (id, body) =>
        attempt(() => edit({ id, body }), "Could not update the comment."),
      remove: (id) =>
        attempt(() => remove({ id }), "Could not delete the comment."),
      resolve: (id) =>
        attempt(() => resolve({ id }), "Could not resolve the comment."),
      reopen: (id) =>
        attempt(() => reopen({ id }), "Could not reopen the comment."),
      createBatch: async (input) => {
        try {
          return await batch(input);
        } catch (error) {
          toast.error(failureMessage(error, "Could not send the comments."));
          return null;
        }
      },
    };
  }, [add, batch, edit, remove, reopen, resolve]);
}
