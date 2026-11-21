import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  ExperimentalDiffLineAnnotation,
  ExperimentalDiffSelectionAction,
} from "@get-bb/plugin-sdk";
import type { GitDiffCardLineSelection } from "@bb/shared-ui/git-diff/card-body";
import type {
  DiffFileEntry,
  GitComment,
  WorkspaceDiffTarget,
} from "../../contract.js";
import { CommentAnnotation } from "./CommentCard.js";
import { useCommentActions } from "./comment-data.js";
import {
  DRAFT_ANNOTATION_ID,
  commentAnnotation,
  commentPath,
} from "./comment-model.js";
import { startCommentDraft, useCommentDraft } from "./draft-store.js";
import {
  DiffCommentsContext,
  useDiffComments,
  type DiffCommentsValue,
} from "./comments-context.js";

const COMMENT_ACTION_ID = "git.comment";

export function DiffCommentsProvider({
  environmentId,
  target,
  comments,
  children,
}: {
  environmentId: string;
  target: WorkspaceDiffTarget;
  comments: readonly GitComment[];
  children: ReactNode;
}) {
  const actions = useCommentActions();
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlight = useCallback(
    (id: string | null) => setHighlightedId(id),
    [],
  );
  const commentsById = useMemo(
    () => new Map(comments.map((comment) => [comment.id as string, comment])),
    [comments],
  );
  const commentsByPath = useMemo(() => {
    const grouped = new Map<string, GitComment[]>();
    for (const comment of comments) {
      const path = commentPath(comment);
      grouped.set(path, [...(grouped.get(path) ?? []), comment]);
    }
    return grouped;
  }, [comments]);
  const value = useMemo<DiffCommentsValue>(
    () => ({
      environmentId,
      target,
      comments,
      commentsById,
      commentsByPath,
      actions,
      highlightedId,
      highlight,
    }),
    [
      actions,
      commentsById,
      commentsByPath,
      comments,
      environmentId,
      highlight,
      highlightedId,
      target,
    ],
  );
  return (
    <DiffCommentsContext.Provider value={value}>
      {children}
    </DiffCommentsContext.Provider>
  );
}

function renderLineAnnotation(annotation: ExperimentalDiffLineAnnotation) {
  return <CommentAnnotation annotationId={annotation.id} />;
}

const NO_COMMENTS: readonly GitComment[] = [];

function sameAnnotations(
  first: readonly ExperimentalDiffLineAnnotation[],
  second: readonly ExperimentalDiffLineAnnotation[],
): boolean {
  return (
    first.length === second.length &&
    first.every((annotation, index) => {
      const other = second[index];
      return (
        other !== undefined &&
        annotation.id === other.id &&
        annotation.side === other.side &&
        annotation.line === other.line
      );
    })
  );
}

export function useFileLineSelection(
  entry: DiffFileEntry,
): GitDiffCardLineSelection | undefined {
  const context = useDiffComments();
  const environmentId = context?.environmentId ?? "";
  const target = context?.target;
  const draft = useCommentDraft(environmentId);
  const fileComments = context?.commentsByPath.get(entry.path) ?? NO_COMMENTS;
  const draftPath = draft?.path;
  const draftSide = draft?.anchor.side;
  const draftLine = draft?.anchor.endLine;

  const nextAnnotations: ExperimentalDiffLineAnnotation[] = [];
  for (const comment of fileComments) {
    const annotation = commentAnnotation(comment);
    if (annotation !== null) nextAnnotations.push(annotation);
  }
  if (
    draftPath === entry.path &&
    draftSide !== undefined &&
    draftLine !== undefined
  ) {
    nextAnnotations.push({
      id: DRAFT_ANNOTATION_ID,
      side: draftSide,
      line: draftLine,
    });
  }
  const [lineAnnotations, setLineAnnotations] = useState(nextAnnotations);
  const annotationsChanged = !sameAnnotations(lineAnnotations, nextAnnotations);
  if (annotationsChanged) setLineAnnotations(nextAnnotations);
  const stableAnnotations = annotationsChanged
    ? nextAnnotations
    : lineAnnotations;

  const revision = entry.revision;
  const path = entry.path;
  const selectionActions = useMemo<
    readonly ExperimentalDiffSelectionAction[] | undefined
  >(() => {
    if (target === undefined) return undefined;
    return [
      {
        id: COMMENT_ACTION_ID,
        label: "Comment",
        icon: "MessageSquare",
        run: (selection) => {
          startCommentDraft(environmentId, {
            path,
            revision,
            target,
            truncated: selection.truncated,
            anchor: {
              path,
              side: selection.side,
              startLine: selection.startLine,
              endLine: selection.endLine,
              lines: [...selection.lines],
              contextBefore: [...selection.contextBefore],
              contextAfter: [...selection.contextAfter],
            },
          });
        },
      },
    ];
  }, [environmentId, path, revision, target]);

  return useMemo(
    () =>
      selectionActions === undefined
        ? undefined
        : {
            selectionActions,
            lineAnnotations: stableAnnotations,
            renderLineAnnotation,
          },
    [stableAnnotations, selectionActions],
  );
}
