import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  GIT_COMMENT_MENTION_PROVIDER_ID,
  type GitComment,
} from "../../contract.js";
import {
  commentAuthorLabel,
  formatCommentCount,
  formatLineRange,
  groupCommentsByFile,
  isOpenComment,
  placementLabel,
} from "./comment-model.js";
import { useDiffComments } from "./comments-context.js";

const ROW_CLASS =
  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BADGE_CLASS =
  "inline-flex items-center rounded-md border border-border px-1.5 py-0.5 text-xs leading-none text-muted-foreground";

function stateLabel(comment: GitComment): string {
  if (comment.state === "resolved") return "Resolved";
  return comment.state === "sent" ? "Sent" : "Unsent";
}

function CommentRow({
  comment,
  onSelect,
}: {
  comment: GitComment;
  onSelect: (comment: GitComment) => void;
}) {
  const placement =
    comment.state === "resolved" ? null : placementLabel(comment);
  return (
    <button
      type="button"
      className={ROW_CLASS}
      onClick={() => onSelect(comment)}
      data-testid="diff-comments-list-row"
      data-comment-id={comment.id}
    >
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {formatLineRange(comment)}
        </span>
        <span className={BADGE_CLASS}>{stateLabel(comment)}</span>
        {placement === null ? null : (
          <span
            className={cn(
              BADGE_CLASS,
              comment.placement.kind === "outdated" && "text-warning",
            )}
          >
            {placement}
          </span>
        )}
        <span>{commentAuthorLabel(comment)}</span>
      </span>
      <span className="line-clamp-2 text-sm text-foreground">
        {comment.body}
      </span>
      {comment.resolution?.note ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          Resolved: {comment.resolution.note}
        </span>
      ) : null}
    </button>
  );
}

export function CommentsListButton({
  onJump,
}: {
  onJump: (path: string, commentId: string) => void;
}) {
  const context = useDiffComments();
  const composer = useComposer();
  const [open, setOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const sendingRef = useRef(false);
  const comments = context?.comments;
  const openComments = useMemo(
    () => (comments ?? []).filter(isOpenComment),
    [comments],
  );
  const unsent = openComments.filter((comment) => comment.state === "unsent");
  const sent = openComments.filter((comment) => comment.state === "sent");
  const groups = useMemo(() => groupCommentsByFile(comments ?? []), [comments]);
  if (context === null) return null;
  const { actions, environmentId } = context;
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;

  async function send(selection: { ids?: string[]; includeSent: boolean }) {
    if (threadId === null || sendingRef.current) return;
    sendingRef.current = true;
    setIsSending(true);
    try {
      const batch = await actions.createBatch({
        environmentId,
        threadId,
        includeSent: selection.includeSent,
        ...(selection.ids === undefined ? {} : { ids: selection.ids }),
      });
      if (batch === null) return;
      composer.insert(
        [
          composer.text.length === 0 || /\s$/u.test(composer.text) ? "" : " ",
          {
            provider: GIT_COMMENT_MENTION_PROVIDER_ID,
            id: batch.batchId,
            label: batch.label,
          },
          " ",
        ],
        { at: "end" },
      );
      composer.focus();
      if (batch.omitted > 0) {
        toast.info(
          `${batch.omitted} more comments are not in this message (it carries at most 200). Send again for the rest.`,
        );
      }
      setOpen(false);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  }

  const sendDisabledReason = threadId === null ? "Open a thread to send" : null;
  const sendCount = unsent.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
            "relative text-muted-foreground",
          )}
          aria-label={`Review comments, ${openComments.length} open`}
        >
          <Icon name="MessageSquare" />
          {openComments.length > 0 ? (
            <span
              className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-xs leading-4 text-primary-foreground"
              data-testid="diff-comments-count"
            >
              {openComments.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        mobileTitle="Review comments"
        className="flex max-h-96 w-96 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Review comments
            </p>
            <p className="text-xs text-muted-foreground">
              {openComments.length === 0
                ? "None open"
                : `${formatCommentCount(openComments.length)} open`}
              {sent.length > 0 ? `, ${sent.length} sent` : ""}
              {sendDisabledReason === null ? "" : `. ${sendDisabledReason}.`}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              size="sm"
              className="h-7 rounded-r-none px-2 text-xs"
              disabled={
                sendCount === 0 || sendDisabledReason !== null || isSending
              }
              onClick={() => void send({ includeSent: false })}
            >
              Send {sendCount}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 rounded-l-none border-l border-primary-foreground/30 px-1.5"
                  aria-label="More send options"
                  disabled={
                    openComments.length === 0 ||
                    sendDisabledReason !== null ||
                    isSending
                  }
                >
                  <Icon name="ChevronDown" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={openComments.length === 0 || isSending}
                  onSelect={() => void send({ includeSent: true })}
                >
                  Include sent comments ({openComments.length})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              No comments yet. Select lines in the diff and choose Comment.
            </p>
          ) : (
            groups.map((group) => {
              const unsentIds = group.comments
                .filter((comment) => comment.state === "unsent")
                .map((comment) => comment.id);
              return (
                <div key={group.path} className="py-1">
                  <div className="flex items-center justify-between gap-2 px-2 py-1">
                    <span
                      className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                      title={group.path}
                    >
                      {group.path}
                    </span>
                    {unsentIds.length > 0 && threadId !== null ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-xs"
                        disabled={isSending}
                        onClick={() =>
                          void send({ ids: unsentIds, includeSent: false })
                        }
                      >
                        Send file
                      </Button>
                    ) : null}
                  </div>
                  {group.comments.map((comment) => (
                    <CommentRow
                      key={comment.id}
                      comment={comment}
                      onSelect={(selected) => {
                        context.highlight(selected.id);
                        onJump(group.path, selected.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
