import { useMemo } from "react";
import type {
  ExperimentalDiffFullFileContents,
  ExperimentalDiffLineAnnotation,
  ExperimentalDiffSelectionAction,
} from "@get-bb/plugin-sdk";
import type { ReactNode } from "react";
import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import type { ParsedGitDiffFile } from "@bb/shared-ui/git-diff/parsing";
import { buildFileDiffPatchText } from "@bb/shared-ui/git-diff/patch-text";
import { BbDiffSplit } from "./BbDiffSplit";
import { useDiffRendererReplacement } from "./codeRendererProvider";
import { DEFAULT_CODE_OVERFLOW, DEFAULT_DIFF_VIEW } from "./code-rendering";
import {
  buildLineSelectionActions,
  toDiffLineSelectionAction,
  type DiffLineSelection,
} from "./line-selection-actions";
import type { DiffPresentation } from "@bb/shared-ui/git-diff/renderers";

const DIFF_RENDERER_SLOT_KIND = "diffRenderer";

interface DiffHostProps extends Partial<DiffPresentation> {
  file: ParsedGitDiffFile;
  patchText?: string;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  className?: string;
  onSelectionAddToChat?: (text: string) => void;
  selectionActions?: readonly ExperimentalDiffSelectionAction[];
  lineAnnotations?: readonly ExperimentalDiffLineAnnotation[];
  renderLineAnnotation?: (
    annotation: ExperimentalDiffLineAnnotation,
  ) => ReactNode;
}

export function DiffHost({
  file,
  patchText,
  fullFileContents,
  view = DEFAULT_DIFF_VIEW,
  overflow = DEFAULT_CODE_OVERFLOW,
  showLineNumbers = true,
  className,
  onSelectionAddToChat,
  selectionActions: pluginSelectionActions,
  lineAnnotations,
  renderLineAnnotation,
}: DiffHostProps) {
  const replacement = useDiffRendererReplacement();
  const selectionActions = useMemo(
    () =>
      buildLineSelectionActions<DiffLineSelection>({
        extraActions: pluginSelectionActions?.map(toDiffLineSelectionAction),
        onAddToChat: onSelectionAddToChat,
      }),
    [pluginSelectionActions, onSelectionAddToChat],
  );
  const isReplaced = replacement.kind === "plugin";
  const semanticPatch = useMemo(
    () => (isReplaced ? (patchText ?? buildFileDiffPatchText(file)) : ""),
    [file, isReplaced, patchText],
  );

  const original = (
    <BbDiffSplit
      file={file}
      patchText={patchText}
      fullFileContents={fullFileContents}
      view={view}
      overflow={overflow}
      showLineNumbers={showLineNumbers}
      className={className}
      selectionActions={selectionActions}
      lineAnnotations={lineAnnotations}
      renderLineAnnotation={renderLineAnnotation}
    />
  );

  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind={DIFF_RENDERER_SLOT_KIND}
    >
      {(slot, BoundOriginal) => (
        <div className={className}>
          <slot.component
            patch={semanticPatch}
            path={file.name}
            view={view}
            overflow={overflow}
            showLineNumbers={showLineNumbers}
            experimental_fullFileContents={fullFileContents}
            Original={BoundOriginal}
          />
        </div>
      )}
    </PluginReplacementSlot>
  );
}
