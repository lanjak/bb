import type { ExperimentalDiffSelectionAction } from "@get-bb/plugin-sdk";
import type { IconName } from "@bb/shared-ui/icon";
import type { DiffLineAnchor } from "@bb/shared-ui/git-diff/patch-text";
import { readSelectedMessageMarkdown } from "@/components/thread/timeline/SelectableMessageProse.js";

export type LineSelectionActionIcon =
  | { kind: "core"; name: IconName }
  | { kind: "plugin"; icon: string | null };

export interface LineSelectionAction<TSelection> {
  id: string;
  label: string;
  icon: LineSelectionActionIcon;
  isAvailable?: (selection: TSelection) => boolean;
  run: (selection: TSelection) => void;
}

export interface CodeLineSelection {
  text: string;
}

export interface DiffLineSelection extends CodeLineSelection {
  anchor: DiffLineAnchor | null;
}

export const ADD_TO_CHAT_ACTION_ID = "core.add-to-chat";

export function createAddToChatAction(
  onAddToChat: (text: string) => void,
): LineSelectionAction<CodeLineSelection> {
  return {
    id: ADD_TO_CHAT_ACTION_ID,
    label: "Add to chat",
    icon: { kind: "core", name: "MessageSquarePlus" },
    run: (selection) =>
      onAddToChat(readSelectedMessageMarkdown() ?? selection.text.trim()),
  };
}

export function toDiffLineSelectionAction(
  action: ExperimentalDiffSelectionAction,
): LineSelectionAction<DiffLineSelection> {
  return {
    id: action.id,
    label: action.label,
    icon: { kind: "plugin", icon: action.icon ?? null },
    isAvailable: (selection) => selection.anchor !== null,
    run: ({ anchor, text }) => {
      if (anchor !== null) {
        action.run({ ...anchor, text });
      }
    },
  };
}

export function buildLineSelectionActions<
  TSelection extends CodeLineSelection,
>({
  extraActions = [],
  onAddToChat,
}: {
  extraActions?: readonly LineSelectionAction<TSelection>[];
  onAddToChat: ((text: string) => void) | undefined;
}): readonly LineSelectionAction<TSelection>[] {
  return onAddToChat === undefined
    ? extraActions
    : [createAddToChatAction(onAddToChat), ...extraActions];
}
