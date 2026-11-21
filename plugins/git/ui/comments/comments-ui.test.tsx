// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { Profiler, type ReactNode } from "react";
import type { GitComment, WorkspaceDiffTarget } from "../../contract.js";
import { gitRpcContract } from "../../rpc-contract.js";
import { makeDiffFileEntry } from "../diff/diff-file-fixtures.js";
import { CommentCard } from "./CommentCard.js";
import { CommentsListButton } from "./CommentsList.js";
import {
  DiffCommentsProvider,
  useFileLineSelection,
} from "./DiffCommentsContext.js";
import { CommentAnnotation } from "./CommentCard.js";
import {
  discardCommentDraft,
  readCommentDraft,
  startCommentDraft,
  useCommentDraft,
} from "./draft-store.js";

const ENVIRONMENT_ID = "env-1";
const TARGET: WorkspaceDiffTarget = { type: "all", mergeBaseBranch: "main" };

type Handlers = Partial<PluginRpcTestHandlers<typeof gitRpcContract>>;

function makeComment(overrides: Partial<GitComment> = {}): GitComment {
  return {
    id: "dcm_0000000000000001",
    environmentId: ENVIRONMENT_ID,
    path: "src/a.ts",
    side: "new",
    startLine: 10,
    endLine: 11,
    lines: ["const a = 1;", "const b = 2;"],
    contextBefore: [],
    contextAfter: [],
    body: "Why is this not cached?",
    author: { kind: "user" },
    state: "unsent",
    placement: { kind: "current", startLine: 10, endLine: 11 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function renderWith(
  ui: (comments: readonly GitComment[]) => ReactNode,
  options: {
    comments?: readonly GitComment[];
    rpc?: Handlers;
    scope?:
      | { kind: "thread"; threadId: string }
      | { kind: "new-thread"; projectId: string | null };
  } = {},
) {
  const comments = options.comments ?? [];
  const rendered = renderSlot(
    {
      component: () => (
        <DiffCommentsProvider
          environmentId={ENVIRONMENT_ID}
          target={TARGET}
          comments={comments}
        >
          {ui(comments)}
        </DiffCommentsProvider>
      ),
    },
    {},
    {
      rpc: (options.rpc ?? {}) as PluginRpcTestHandlers<typeof gitRpcContract>,
      experimental_rpcContract: gitRpcContract,
      pluginId: "bb--git",
      composer: {
        scope: options.scope ?? { kind: "thread", threadId: "thr-1" },
      },
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ title: "Fix login" }),
        },
      },
    },
  );
  return rendered;
}

afterEach(() => {
  cleanup();
  discardCommentDraft(ENVIRONMENT_ID);
  vi.clearAllMocks();
});

const ANCHOR = {
  path: "src/a.ts",
  side: "new" as const,
  startLine: 10,
  endLine: 11,
  lines: ["const a = 1;", "const b = 2;"],
  contextBefore: ["// before"],
  contextAfter: ["// after"],
};

function DraftHarness() {
  return <CommentAnnotation annotationId="draft" />;
}

describe("draft comment card", () => {
  it("saves the typed comment with its anchor and revision, then clears the draft", async () => {
    const addComment = vi.fn(async () => ({ comment: makeComment() }));
    const rendered = renderWith(() => <DraftHarness />, {
      rpc: { addComment },
    });
    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/a.ts",
        revision: "100644:aaa:100644:bbb",
        target: TARGET,
        anchor: ANCHOR,
        truncated: false,
      });
    });
    const textbox = await screen.findByRole("textbox", { name: "Comment" });
    expect(document.activeElement).toBe(textbox);
    expect(
      (screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(textbox, { target: { value: "  Use a cache  " } });
    expect(readCommentDraft(ENVIRONMENT_ID)?.body).toBe("  Use a cache  ");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(readCommentDraft(ENVIRONMENT_ID)).toBeNull());
    expect(rendered.rpcCalls).toContainEqual({
      method: "addComment",
      input: {
        environmentId: ENVIRONMENT_ID,
        target: TARGET,
        revision: "100644:aaa:100644:bbb",
        anchor: ANCHOR,
        body: "Use a cache",
        byPerson: true,
      },
    });
  });

  it("saves on Mod+Enter, ignores Enter while composing, and cancels on Escape", async () => {
    const addComment = vi.fn(async () => ({ comment: makeComment() }));
    renderWith(() => <DraftHarness />, { rpc: { addComment } });
    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/a.ts",
        revision: "rev",
        target: TARGET,
        anchor: ANCHOR,
        truncated: false,
      });
    });
    const textbox = await screen.findByRole("textbox", { name: "Comment" });
    fireEvent.change(textbox, { target: { value: "Text" } });

    fireEvent.keyDown(textbox, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true, keyCode: 229 });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(addComment).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: "Escape", isComposing: true });
    expect(readCommentDraft(ENVIRONMENT_ID)).not.toBeNull();

    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));

    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/a.ts",
        revision: "rev",
        target: TARGET,
        anchor: ANCHOR,
        truncated: false,
      });
    });
    const second = await screen.findByRole("textbox", { name: "Comment" });
    fireEvent.keyDown(second, { key: "Escape" });
    expect(readCommentDraft(ENVIRONMENT_ID)).toBeNull();
  });

  it("keeps the draft when saving fails", async () => {
    const addComment = vi.fn(async () => {
      throw new Error("Comment limit reached");
    });
    renderWith(() => <DraftHarness />, { rpc: { addComment } });
    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/a.ts",
        revision: "rev",
        target: TARGET,
        anchor: ANCHOR,
        truncated: false,
      });
    });
    const textbox = await screen.findByRole("textbox", { name: "Comment" });
    fireEvent.change(textbox, { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(addComment).toHaveBeenCalled());
    expect(readCommentDraft(ENVIRONMENT_ID)?.body).toBe("Keep me");
  });
});

describe("draft comment card limits", () => {
  const draftRpc = {
    addComment: vi.fn(async () => ({ comment: makeComment() })),
  };

  it("says when the selection was cut and what the comment covers", async () => {
    renderWith(() => <DraftHarness />, { rpc: draftRpc });
    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/a.ts",
        revision: "rev",
        target: TARGET,
        anchor: ANCHOR,
        truncated: true,
      });
    });
    await screen.findByRole("textbox", { name: "Comment" });
    expect(
      screen.getByText(/longer than 50 lines or crossed a gap in the diff/u)
        .textContent,
    ).toContain("This comment covers L10-11");
  });

  it("refuses code the server would reject instead of failing after the click", async () => {
    renderWith(() => <DraftHarness />, { rpc: draftRpc });
    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/min.js",
        revision: "rev",
        target: TARGET,
        anchor: {
          ...ANCHOR,
          startLine: 1,
          endLine: 1,
          lines: ["x".repeat(9_000)],
          contextBefore: [],
          contextAfter: [],
        },
        truncated: false,
      });
    });
    const textbox = await screen.findByRole("textbox", { name: "Comment" });
    fireEvent.change(textbox, { target: { value: "Looks odd" } });
    expect(screen.getByRole("alert").textContent).toContain("too large");
    expect(
      (screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
    expect(draftRpc.addComment).not.toHaveBeenCalled();
  });

  it("does not re-render the rows that watch the draft while someone types", async () => {
    const rowCommits = { count: 0 };
    function RowProbe() {
      useCommentDraft(ENVIRONMENT_ID);
      return null;
    }
    renderWith(() => (
      <>
        <Profiler
          id="row"
          onRender={() => {
            rowCommits.count += 1;
          }}
        >
          <RowProbe />
        </Profiler>
        <DraftHarness />
      </>
    ));
    act(() => {
      startCommentDraft(ENVIRONMENT_ID, {
        path: "src/a.ts",
        revision: "rev",
        target: TARGET,
        anchor: ANCHOR,
        truncated: false,
      });
    });
    const textbox = await screen.findByRole("textbox", { name: "Comment" });
    const before = rowCommits.count;
    for (const value of ["a", "ab", "abc", "abcd"]) {
      fireEvent.change(textbox, { target: { value } });
    }
    expect(rowCommits.count).toBe(before);
    expect(readCommentDraft(ENVIRONMENT_ID)?.body).toBe("abcd");
  });
});

describe("comment card", () => {
  it("shows the state and placement of an unsent moved comment and lets the person edit, resolve and delete it", async () => {
    const comment = makeComment({
      placement: {
        kind: "moved",
        startLine: 20,
        endLine: 21,
        fromStartLine: 10,
      },
    });
    const rendered = renderWith(() => <CommentCard comment={comment} />, {
      comments: [comment],
      rpc: {
        editComment: async () => ({ ok: true }),
        resolveComment: async () => ({ ok: true }),
        deleteComment: async () => ({ ok: true }),
      },
    });
    expect(screen.getByText("Unsent")).toBeTruthy();
    expect(screen.getByText("Moved from L10")).toBeTruthy();
    expect(screen.getByText("L20-21")).toBeTruthy();
    expect(screen.getByTestId("bb-markdown").textContent).toBe(
      "Why is this not cached?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textbox = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(textbox, { target: { value: "Cache it" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "editComment",
        input: { id: comment.id, body: "Cache it" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "resolveComment",
        input: { id: comment.id },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      rendered.rpcCalls.filter((call) => call.method === "deleteComment"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "deleteComment",
        input: { id: comment.id },
      }),
    );
  });

  it("marks outdated comments and shows a sent badge", () => {
    const outdated = makeComment({
      placement: { kind: "outdated" },
      state: "sent",
      sent: {
        batchId: "dcb_0000000000000001",
        threadId: "thr-1",
        at: Date.now(),
      },
    });
    renderWith(() => <CommentCard comment={outdated} />, {
      comments: [outdated],
    });
    expect(screen.getByText("Outdated")).toBeTruthy();
    expect(screen.getByText(/^Sent/)).toBeTruthy();
  });

  it("collapses a resolved comment to one line with the agent's note and reopens it", async () => {
    const resolved = makeComment({
      state: "resolved",
      resolution: { at: 5, note: "Added a TTL cache", byThreadId: "thr-1" },
    });
    const rendered = renderWith(() => <CommentCard comment={resolved} />, {
      comments: [resolved],
      rpc: { reopenComment: async () => ({ ok: true }) },
    });
    const row = screen.getByTestId("diff-comment");
    expect(row.getAttribute("data-state")).toBe("resolved");
    expect(row.textContent).toContain("Resolved L10-11 - Added a TTL cache");
    expect(screen.queryByTestId("bb-markdown")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Show resolved comment/ }),
    );
    expect(screen.getByTestId("bb-markdown").textContent).toBe(
      "Why is this not cached?",
    );
    expect(screen.getByText(/Agent note/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "reopenComment",
        input: { id: resolved.id },
      }),
    );
  });
});

describe("comments list", () => {
  const comments = [
    makeComment(),
    makeComment({
      id: "dcm_0000000000000002",
      path: "src/b.ts",
      body: "Rename this",
      startLine: 3,
      endLine: 3,
      placement: { kind: "outdated" },
      state: "sent",
      sent: { batchId: "dcb_0000000000000001", threadId: "thr-1", at: 1 },
    }),
    makeComment({
      id: "dcm_0000000000000003",
      body: "Already handled",
      state: "resolved",
      resolution: { at: 2, note: "Cached it" },
      placement: { kind: "outdated" },
    }),
  ];

  it("counts open comments, groups them by file, and jumps to one", async () => {
    const onJump = vi.fn();
    renderWith(() => <CommentsListButton onJump={onJump} />, { comments });
    expect(screen.getByTestId("diff-comments-count").textContent).toBe("2");
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 2 open" }),
    );
    const rows = await screen.findAllByTestId("diff-comments-list-row");
    expect(rows.map((row) => row.getAttribute("data-comment-id"))).toEqual([
      "dcm_0000000000000001",
      "dcm_0000000000000003",
      "dcm_0000000000000002",
    ]);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(screen.getAllByText("Outdated")).toHaveLength(1);
    expect(screen.getByText("Resolved: Cached it")).toBeTruthy();
    fireEvent.click(rows[2]!);
    expect(onJump).toHaveBeenCalledWith("src/b.ts", "dcm_0000000000000002");
  });

  it("sends the unsent comments as one batch chip in the thread's composer", async () => {
    const createCommentBatch = vi.fn(async () => ({
      batchId: "dcb_00000000000000aa",
      count: 1,
      omitted: 0,
      label: "1 review comment",
    }));
    const rendered = renderWith(() => <CommentsListButton onJump={vi.fn()} />, {
      comments,
      rpc: { createCommentBatch },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 2 open" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send 1" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "createCommentBatch",
        input: {
          environmentId: ENVIRONMENT_ID,
          threadId: "thr-1",
          includeSent: false,
        },
      }),
    );
    await waitFor(() =>
      expect(rendered.inspection.composer.draft.mentions).toMatchObject([
        {
          provider: "review-comments",
          id: "dcb_00000000000000aa",
          label: "1 review comment",
        },
      ]),
    );
    expect(rendered.inspection.composer.focusCount).toBeGreaterThan(0);
  });

  it("sends one file's unsent comments by id, so a renamed file works", async () => {
    const renamed = makeComment({
      id: "dcm_0000000000000009",
      path: "src/old-name.ts",
      currentPath: "src/new-name.ts",
    });
    const createCommentBatch = vi.fn(async () => ({
      batchId: "dcb_00000000000000bb",
      count: 1,
      omitted: 0,
      label: "1 review comment",
    }));
    const rendered = renderWith(() => <CommentsListButton onJump={vi.fn()} />, {
      comments: [renamed],
      rpc: { createCommentBatch },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 1 open" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send file" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "createCommentBatch",
        input: {
          environmentId: ENVIRONMENT_ID,
          threadId: "thr-1",
          includeSent: false,
          ids: ["dcm_0000000000000009"],
        },
      }),
    );
  });

  it("ignores a second click on Send while the first is in flight", async () => {
    let release: (() => void) | undefined;
    const createCommentBatch = vi.fn(
      () =>
        new Promise<{
          batchId: string;
          count: number;
          omitted: number;
          label: string;
        }>((resolve) => {
          release = () =>
            resolve({
              batchId: "dcb_00000000000000cc",
              count: 1,
              omitted: 0,
              label: "1 review comment",
            });
        }),
    );
    const rendered = renderWith(() => <CommentsListButton onJump={vi.fn()} />, {
      comments,
      rpc: { createCommentBatch },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 2 open" }),
    );
    const send = await screen.findByRole("button", { name: "Send 1" });
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(rendered.inspection.composer.draft.mentions).toHaveLength(1),
    );
    expect(
      rendered.rpcCalls.filter((call) => call.method === "createCommentBatch"),
    ).toHaveLength(1);
  });

  it("tells the person when a batch left comments out", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "toast");
    const createCommentBatch = vi.fn(async () => ({
      batchId: "dcb_00000000000000dd",
      count: 200,
      omitted: 7,
      label: "200 review comments",
    }));
    renderWith(() => <CommentsListButton onJump={vi.fn()} />, {
      comments,
      rpc: { createCommentBatch },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 2 open" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send 1" }));
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(String(info.mock.calls[0]?.[0])).toContain("7 more comments");
    info.mockRestore();
  });

  it("cannot send without a thread composer", async () => {
    renderWith(() => <CommentsListButton onJump={vi.fn()} />, {
      comments,
      scope: { kind: "new-thread", projectId: null },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 2 open" }),
    );
    expect(
      (
        (await screen.findByRole("button", {
          name: "Send 1",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Open a thread to send/)).toBeTruthy();
  });

  it("explains how to start when there are no comments", async () => {
    renderWith(() => <CommentsListButton onJump={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Review comments, 0 open" }),
    );
    expect(
      await screen.findByText(/Select lines in the diff and choose Comment/),
    ).toBeTruthy();
  });
});

describe("file line selection", () => {
  function SelectionProbe({
    onValue,
  }: {
    onValue: (value: ReturnType<typeof useFileLineSelection>) => void;
  }) {
    onValue(
      useFileLineSelection(
        makeDiffFileEntry({ path: "src/a.ts", revision: "rev-a" }),
      ),
    );
    return null;
  }

  it("adds a Comment action that opens a draft with the mapped anchor, and annotates comments and the draft", () => {
    let latest: ReturnType<typeof useFileLineSelection>;
    const comments = [
      makeComment(),
      makeComment({
        id: "dcm_0000000000000002",
        placement: { kind: "outdated" },
      }),
      makeComment({ id: "dcm_0000000000000003", path: "src/other.ts" }),
    ];
    renderWith(() => <SelectionProbe onValue={(value) => (latest = value)} />, {
      comments,
    });
    expect(latest!.lineAnnotations).toEqual([
      { id: "dcm_0000000000000001", side: "new", line: 11 },
    ]);
    const [action] = latest!.selectionActions ?? [];
    expect(action).toMatchObject({ id: "git.comment", label: "Comment" });

    act(() => {
      action!.run({
        side: "new",
        startLine: 30,
        endLine: 31,
        lines: ["x", "y"],
        contextBefore: ["w"],
        contextAfter: ["z"],
        text: "patch",
        truncated: false,
        selectedFrom: { side: "new", line: 30 },
        selectedTo: { side: "new", line: 31 },
      });
    });
    expect(readCommentDraft(ENVIRONMENT_ID)).toMatchObject({
      path: "src/a.ts",
      revision: "rev-a",
      target: TARGET,
      anchor: {
        path: "src/a.ts",
        side: "new",
        startLine: 30,
        endLine: 31,
        lines: ["x", "y"],
        contextBefore: ["w"],
        contextAfter: ["z"],
      },
    });
    expect(latest!.lineAnnotations).toEqual([
      { id: "dcm_0000000000000001", side: "new", line: 11 },
      { id: "draft", side: "new", line: 31 },
    ]);
  });
});
