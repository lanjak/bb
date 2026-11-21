import { useMemo } from "react";
import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import { BbSourceCodeSplit } from "./BbSourceCodeSplit";
import { useSourceCodeRendererReplacement } from "./codeRendererProvider";
import {
  DEFAULT_CODE_OVERFLOW,
  type BbSourceCodeProps,
} from "./code-rendering";
import {
  buildLineSelectionActions,
  type CodeLineSelection,
} from "./line-selection-actions";

const SOURCE_CODE_RENDERER_SLOT_KIND = "sourceCodeRenderer";

interface SourceCodeHostProps extends Omit<
  BbSourceCodeProps,
  "overflow" | "highlightedLines" | "selectionActions"
> {
  overflow?: BbSourceCodeProps["overflow"];
  highlightedLines?: BbSourceCodeProps["highlightedLines"];
  onSelectionAddToChat?: (text: string) => void;
}

export function SourceCodeHost({
  content,
  path,
  cacheKey,
  overflow = DEFAULT_CODE_OVERFLOW,
  highlightedLines = null,
  className,
  scrollToHighlightedLines,
  onSelectionAddToChat,
}: SourceCodeHostProps) {
  const replacement = useSourceCodeRendererReplacement();
  const selectionActions = useMemo(
    () =>
      buildLineSelectionActions<CodeLineSelection>({
        onAddToChat: onSelectionAddToChat,
      }),
    [onSelectionAddToChat],
  );

  const original = (
    <BbSourceCodeSplit
      content={content}
      path={path}
      cacheKey={cacheKey}
      overflow={overflow}
      highlightedLines={highlightedLines}
      className={className}
      scrollToHighlightedLines={scrollToHighlightedLines}
      selectionActions={selectionActions}
    />
  );

  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind={SOURCE_CODE_RENDERER_SLOT_KIND}
    >
      {(slot, BoundOriginal) => (
        <div className={className}>
          <slot.component
            content={content}
            path={path}
            overflow={overflow}
            highlightedLines={highlightedLines}
            Original={BoundOriginal}
          />
        </div>
      )}
    </PluginReplacementSlot>
  );
}
