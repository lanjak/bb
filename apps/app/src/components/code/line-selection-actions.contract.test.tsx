// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePierreLineSelectionActions } from "@/components/git-diff/PierreLineSelectionActions.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import {
  buildLineSelectionActions,
  type CodeLineSelection,
  type LineSelectionAction,
} from "./line-selection-actions";

afterEach(() => {
  cleanup();
});

interface SurfaceHandle {
  open: () => void;
  node: ReactNode;
}

interface Surface {
  name: string;
  build: (args: {
    onAddToChat: (text: string) => void;
    extra: LineSelectionAction<CodeLineSelection>;
  }) => SurfaceHandle;
}

function LineHookHarness({
  actions,
}: {
  actions: readonly LineSelectionAction<CodeLineSelection>[];
}) {
  const selection = usePierreLineSelectionActions({
    actions,
    buildSelection: () => ({ text: "selected lines" }),
    containerRef: { current: null },
  });
  return (
    <>
      <button
        type="button"
        data-testid="open-selection"
        onClick={() => selection.onGutterUtilityClick({ start: 1, end: 1 })}
      />
      {selection.menu}
    </>
  );
}

const SURFACES: Surface[] = [
  {
    name: "line selection menu (BbDiff, BbSourceCode and plugin Diff share it)",
    build: ({ onAddToChat, extra }) => {
      const actions = buildLineSelectionActions<CodeLineSelection>({
        extraActions: [extra],
        onAddToChat,
      });
      return {
        node: <LineHookHarness actions={actions} />,
        open: () => fireEvent.click(screen.getByTestId("open-selection")),
      };
    },
  },
  {
    name: "timeline selection menu (message prose)",
    build: ({ onAddToChat, extra }) => ({
      node: (
        <TimelineSelectionMenu
          selection={{
            text: "selected lines",
            rect: new DOMRect(10, 10, 100, 20),
          }}
          onAddToChat={onAddToChat}
          actions={[
            {
              key: extra.id,
              label: extra.label,
              icon: "MessageSquare",
              onSelect: () => extra.run({ text: "selected lines" }),
            },
          ]}
          onDismiss={() => {}}
        />
      ),
      open: () => {},
    }),
  },
];

describe.each(SURFACES)("Add to chat on the $name", ({ build }) => {
  it("is the first entry, with the plugin action after it", () => {
    const extra = {
      id: "plugin.comment",
      label: "Comment",
      icon: { kind: "plugin" as const, icon: null },
      run: vi.fn(),
    };
    const handle = build({ onAddToChat: vi.fn(), extra });
    render(<>{handle.node}</>);
    handle.open();
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.dataset["testid"] !== "open-selection")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["Add to chat", "Comment"]);
  });

  it("hands the selected text to the Add to chat handler", () => {
    const onAddToChat = vi.fn();
    const handle = build({
      onAddToChat,
      extra: {
        id: "plugin.comment",
        label: "Comment",
        icon: { kind: "plugin", icon: null },
        run: vi.fn(),
      },
    });
    render(<>{handle.node}</>);
    handle.open();
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("selected lines");
  });

  it("runs the plugin action and not Add to chat for its own entry", () => {
    const onAddToChat = vi.fn();
    const run = vi.fn();
    const handle = build({
      onAddToChat,
      extra: {
        id: "plugin.comment",
        label: "Comment",
        icon: { kind: "plugin", icon: null },
        run,
      },
    });
    render(<>{handle.node}</>);
    handle.open();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onAddToChat).not.toHaveBeenCalled();
  });
});
