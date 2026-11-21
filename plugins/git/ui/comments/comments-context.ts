import { createContext, useContext } from "react";
import type { GitComment, WorkspaceDiffTarget } from "../../contract.js";
import type { CommentActions } from "./comment-data.js";

export interface DiffCommentsValue {
  environmentId: string;
  target: WorkspaceDiffTarget;
  comments: readonly GitComment[];
  commentsById: ReadonlyMap<string, GitComment>;
  commentsByPath: ReadonlyMap<string, readonly GitComment[]>;
  actions: CommentActions;
  highlightedId: string | null;
  highlight: (id: string | null) => void;
}

export const DiffCommentsContext = createContext<DiffCommentsValue | null>(
  null,
);

export function useDiffComments(): DiffCommentsValue | null {
  return useContext(DiffCommentsContext);
}
