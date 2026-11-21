import { useEffect, useRef, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Textarea } from "@bb/shared-ui/textarea";
import { cn } from "@bb/shared-ui/lib/utils";
import { isNonImeKey } from "@/lib/ime-keyboard";
import { gitCommentAnchorSchema, type GitComment } from "../../contract.js";
import { useThreadTitle } from "./thread-title.js";
import {
  DRAFT_ANNOTATION_ID,
  commentAuthorLabel,
  formatSentTime,
  formatLineRange,
  placementLabel,
} from "./comment-model.js";
import { useDiffComments } from "./comments-context.js";
import {
  discardCommentDraft,
  readCommentDraftBody,
  setCommentDraftBody,
  useCommentDraft,
} from "./draft-store.js";

const CARD_CLASS =
  "mx-2 my-1.5 min-w-0 max-w-full whitespace-normal break-words rounded-lg border border-border bg-surface-raised font-sans text-sm text-foreground";
const BADGE_CLASS =
  "inline-flex items-center rounded-md border border-border px-1.5 py-0.5 text-xs leading-none text-muted-foreground";
const ACTION_CLASS = "h-6 px-2 text-xs";

function isSaveShortcut(event: React.KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && isNonImeKey(event, "Enter");
}

function CommentEditor({
  initialBody,
  submitLabel,
  autoFocus,
  isSaving,
  blockedReason,
  onChange,
  onSubmit,
  onCancel,
}: {
  initialBody: string;
  submitLabel: string;
  autoFocus: boolean;
  isSaving: boolean;
  blockedReason?: string | undefined;
  onChange?: (body: string) => void;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);
  const canSubmit =
    body.trim().length > 0 && !isSaving && blockedReason === undefined;
  return (
    <div className="flex flex-col gap-2 p-2">
      <Textarea
        ref={textareaRef}
        value={body}
        rows={3}
        aria-label="Comment"
        placeholder="Leave a comment for the agent"
        className="min-h-16 resize-y text-sm"
        onChange={(event) => {
          setBody(event.target.value);
          onChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (isNonImeKey(event, "Escape")) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (isSaveShortcut(event) && canSubmit) {
            event.preventDefault();
            onSubmit(body);
          }
        }}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={ACTION_CLASS}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className={ACTION_CLASS}
          disabled={!canSubmit}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          onClick={() => onSubmit(body)}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function DraftCommentCard({ environmentId }: { environmentId: string }) {
  const draft = useCommentDraft(environmentId);
  const context = useDiffComments();
  const [isSaving, setIsSaving] = useState(false);
  if (draft === null || context === null) return null;
  const { anchor } = draft;
  const range =
    anchor.startLine === anchor.endLine
      ? `${anchor.startLine}`
      : `${anchor.startLine}-${anchor.endLine}`;
  const blockedReason = gitCommentAnchorSchema.safeParse(anchor).success
    ? undefined
    : "This code is too large to comment on. Select fewer or shorter lines.";
  return (
    <div className={CARD_CLASS} data-testid="diff-comment-draft">
      <div className="flex items-center gap-2 px-2 pt-2 text-xs text-muted-foreground">
        <Icon name="MessageSquare" className="size-3.5" />
        <span>
          Comment on {anchor.side === "old" ? "removed " : ""}L{range}
        </span>
      </div>
      {blockedReason === undefined ? null : (
        <p role="alert" className="px-2 pt-1 text-xs text-destructive">
          {blockedReason}
        </p>
      )}
      {draft.truncated && blockedReason === undefined ? (
        <p className="px-2 pt-1 text-xs text-muted-foreground">
          The selection was longer than 50 lines or crossed a gap in the diff.
          This comment covers L{range}.
        </p>
      ) : null}
      <CommentEditor
        initialBody={readCommentDraftBody(environmentId)}
        submitLabel="Comment"
        autoFocus
        isSaving={isSaving}
        blockedReason={blockedReason}
        onChange={(body) => setCommentDraftBody(environmentId, body)}
        onCancel={() => discardCommentDraft(environmentId)}
        onSubmit={(body) => {
          setIsSaving(true);
          void context.actions
            .add({
              environmentId,
              target: draft.target,
              revision: draft.revision,
              anchor: draft.anchor,
              body: body.trim(),
              byPerson: true,
            })
            .then((saved) => {
              if (saved) discardCommentDraft(environmentId);
            })
            .finally(() => setIsSaving(false));
        }}
      />
    </div>
  );
}

function StateBadge({ comment }: { comment: GitComment }) {
  const threadTitle = useThreadTitle(comment.sent?.threadId ?? null);
  if (comment.state === "resolved") {
    return <span className={cn(BADGE_CLASS, "text-success")}>Resolved</span>;
  }
  if (comment.state === "sent" && comment.sent !== undefined) {
    return (
      <span
        className={BADGE_CLASS}
        title={`Sent ${new Date(comment.sent.at).toLocaleString()} to thread ${comment.sent.threadId}`}
      >
        Sent{threadTitle === null ? "" : ` to ${threadTitle}`} ·{" "}
        {formatSentTime(comment.sent.at)}
      </span>
    );
  }
  return <span className={BADGE_CLASS}>Unsent</span>;
}

export function CommentCard({ comment }: { comment: GitComment }) {
  const context = useDiffComments();
  const [isEditing, setIsEditing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isHighlighted = context?.highlightedId === comment.id;
  useEffect(() => {
    if (isHighlighted) {
      rootRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isHighlighted]);
  if (context === null) return null;
  const { actions } = context;
  const isResolved = comment.state === "resolved";
  const placement = isResolved ? null : placementLabel(comment);

  if (isResolved && !isExpanded) {
    const summary = comment.resolution?.note ?? comment.body.split("\n")[0];
    return (
      <div
        ref={rootRef}
        className={cn(
          CARD_CLASS,
          "flex items-center gap-2 px-2 py-1 text-muted-foreground",
          isHighlighted && "ring-1 ring-ring",
        )}
        data-testid="diff-comment"
        data-comment-id={comment.id}
        data-state="resolved"
      >
        <Icon name="CircleCheck" className="size-3.5 shrink-0 text-success" />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs hover:text-foreground"
          onClick={() => setIsExpanded(true)}
          aria-label={`Show resolved comment on ${formatLineRange(comment)}`}
        >
          <span className="text-foreground">
            Resolved {formatLineRange(comment)}
          </span>
          {summary ? ` - ${summary}` : ""}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={ACTION_CLASS}
          onClick={() => void actions.reopen(comment.id)}
        >
          Reopen
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cn(CARD_CLASS, isHighlighted && "ring-1 ring-ring")}
      data-testid="diff-comment"
      data-comment-id={comment.id}
      data-state={comment.state}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground">
        <Icon name="MessageSquare" className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">
          {commentAuthorLabel(comment)}
        </span>
        <span>{formatLineRange(comment)}</span>
        <StateBadge comment={comment} />
        {placement !== null ? (
          <span
            className={cn(
              BADGE_CLASS,
              comment.placement.kind === "outdated" && "text-warning",
            )}
          >
            {placement}
          </span>
        ) : null}
      </div>
      {isEditing ? (
        <CommentEditor
          initialBody={comment.body}
          submitLabel="Save"
          autoFocus
          isSaving={isSaving}
          onCancel={() => setIsEditing(false)}
          onSubmit={(body) => {
            setIsSaving(true);
            void actions
              .edit(comment.id, body.trim())
              .then((saved) => {
                if (saved) setIsEditing(false);
              })
              .finally(() => setIsSaving(false));
          }}
        />
      ) : (
        <div className="px-2 py-1.5">
          <Markdown content={comment.body} className="text-sm" />
          {comment.resolution?.note ? (
            <div className="mt-1.5 border-t border-border pt-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {comment.resolution.byThreadId === undefined
                  ? "Resolved"
                  : "Agent note"}
                :
              </span>{" "}
              {comment.resolution.note}
            </div>
          ) : null}
        </div>
      )}
      {isEditing ? null : (
        <div className="flex items-center justify-end gap-1 px-2 pb-1.5">
          {isConfirmingDelete ? (
            <>
              <span className="mr-1 text-xs text-muted-foreground">
                Delete this comment?
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={ACTION_CLASS}
                onClick={() => setIsConfirmingDelete(false)}
              >
                Keep
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(ACTION_CLASS, "text-destructive")}
                onClick={() => void actions.remove(comment.id)}
              >
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={ACTION_CLASS}
                onClick={() => setIsEditing(true)}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={ACTION_CLASS}
                onClick={() => setIsConfirmingDelete(true)}
              >
                Delete
              </Button>
              {isResolved ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={ACTION_CLASS}
                  onClick={() => void actions.reopen(comment.id)}
                >
                  Reopen
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={ACTION_CLASS}
                  onClick={() => void actions.resolve(comment.id)}
                >
                  Resolve
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CommentAnnotation({ annotationId }: { annotationId: string }) {
  const context = useDiffComments();
  if (context === null) return null;
  if (annotationId === DRAFT_ANNOTATION_ID) {
    return <DraftCommentCard environmentId={context.environmentId} />;
  }
  const comment = context.commentsById.get(annotationId);
  return comment === undefined ? null : <CommentCard comment={comment} />;
}
