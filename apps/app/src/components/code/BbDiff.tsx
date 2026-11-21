import { DiffLoadingSkeleton } from "@bb/shared-ui/diff-loading-skeleton";
import { useCallback, useMemo, useRef, type CSSProperties } from "react";
import type {
  DiffLineAnnotation,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff as DiffView } from "@pierre/diffs/react";
import { usePierreLineSelectionActions } from "@/components/git-diff/PierreLineSelectionActions.js";
import { PierreWorkerPoolBoundary } from "@/lib/pierre-worker-pool-boundary";
import { useRequirePierreWorkerPool } from "@/lib/pierre-worker-pool-gate";
import { usePierreStrictModeRecoveryOptions } from "@/lib/pierre-strict-mode-recovery";
import {
  buildFileDiffPatchText,
  buildDiffDomSelectionText,
  buildDiffLineSelectionText,
  diffSelectionToAnchor,
} from "@bb/shared-ui/git-diff/patch-text";
import { enrichGitDiffFileForContext } from "@bb/shared-ui/git-diff/parsing";
import { useResolvedCodeThemePair } from "@/lib/code-theme";
import { usePreferredTheme } from "@/hooks/useTheme";
import { cn } from "@bb/shared-ui/lib/utils";
import type { BbDiffProps } from "./code-rendering";
import type { ExperimentalDiffLineAnnotation } from "@get-bb/plugin-sdk";
import type { DiffLineSelection } from "./line-selection-actions";

const DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;

const DIFF_CODE_WITHOUT_VERTICAL_SCROLLBAR_GUTTER_CSS =
  "[data-code]{scrollbar-gutter:auto}";

const DEFAULT_DIFF_EXPANSION_LINE_COUNT = 30;

function BbDiff({
  file,
  patchText,
  fullFileContents,
  view,
  overflow,
  showLineNumbers,
  className,
  selectionActions,
  lineAnnotations,
  renderLineAnnotation,
}: BbDiffProps) {
  const oldPath = fullFileContents?.old.path;
  const oldContent = fullFileContents?.old.content;
  const newPath = fullFileContents?.new.path;
  const newContent = fullFileContents?.new.content;
  const resolvedFile = useMemo(() => {
    if (
      oldPath === undefined ||
      oldContent === undefined ||
      newPath === undefined ||
      newContent === undefined
    ) {
      return file;
    }
    return enrichGitDiffFileForContext({
      fileDiff: file,
      oldFile: { name: oldPath, contents: oldContent },
      newFile: { name: newPath, contents: newContent },
      patchText: patchText ?? buildFileDiffPatchText(file),
    });
  }, [file, newContent, newPath, oldContent, oldPath, patchText]);
  const expansionLineCount =
    resolvedFile !== file && resolvedFile.isPartial === false
      ? DEFAULT_DIFF_EXPANSION_LINE_COUNT
      : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const codeTheme = useResolvedCodeThemePair();
  const themeType = usePreferredTheme();
  const buildSelection = useCallback(
    (range: SelectedLineRange): DiffLineSelection | null => {
      const text = buildDiffLineSelectionText({
        displayStyle: view,
        fileDiff: resolvedFile,
        range,
      });
      if (text === null) {
        return null;
      }
      return {
        text,
        anchor: diffSelectionToAnchor({
          displayStyle: view,
          fileDiff: resolvedFile,
          range,
        }),
      };
    },
    [resolvedFile, view],
  );
  const buildFallbackSelection = useCallback(
    ({
      containerElement,
    }: {
      containerElement: HTMLElement | null;
      range: SelectedLineRange;
    }): DiffLineSelection | null => {
      const text = buildDiffDomSelectionText({
        containerElement,
        fileDiff: resolvedFile,
      });
      return text === null ? null : { text, anchor: null };
    },
    [resolvedFile],
  );
  const lineSelectionActions = usePierreLineSelectionActions({
    actions: selectionActions,
    buildFallbackSelection,
    buildSelection,
    containerRef,
  });
  const hasSelectionActions = selectionActions.length > 0;
  const baseOptions = useMemo<FileDiffOptions<ExperimentalDiffLineAnnotation>>(
    () => ({
      diffStyle: view,
      overflow,
      disableLineNumbers: !showLineNumbers,
      disableFileHeader: true,
      ...(expansionLineCount === undefined ? {} : { expansionLineCount }),
      themeType,
      theme: codeTheme,
      enableGutterUtility: hasSelectionActions,
      enableLineSelection: hasSelectionActions,
      lineHoverHighlight: hasSelectionActions ? "number" : "disabled",
      onGutterUtilityClick: hasSelectionActions
        ? lineSelectionActions.onGutterUtilityClick
        : undefined,
      onLineSelectionChange: lineSelectionActions.onLineSelectionChange,
      onLineSelectionEnd: lineSelectionActions.onLineSelectionEnd,
      onLineSelectionStart: lineSelectionActions.onLineSelectionStart,
      unsafeCSS: DIFF_CODE_WITHOUT_VERTICAL_SCROLLBAR_GUTTER_CSS,
    }),
    [
      codeTheme,
      expansionLineCount,
      hasSelectionActions,
      lineSelectionActions.onGutterUtilityClick,
      lineSelectionActions.onLineSelectionChange,
      lineSelectionActions.onLineSelectionEnd,
      lineSelectionActions.onLineSelectionStart,
      overflow,
      showLineNumbers,
      themeType,
      view,
    ],
  );
  const options = usePierreStrictModeRecoveryOptions(baseOptions);
  const pierreAnnotations = useMemo(
    () =>
      lineAnnotations?.map((annotation) => ({
        side:
          annotation.side === "new"
            ? ("additions" as const)
            : ("deletions" as const),
        lineNumber: annotation.line,
        metadata: annotation,
      })),
    [lineAnnotations],
  );
  const renderPierreAnnotation = useCallback(
    ({ metadata }: DiffLineAnnotation<ExperimentalDiffLineAnnotation>) =>
      renderLineAnnotation?.(metadata) ?? null,
    [renderLineAnnotation],
  );
  const isWorkerPoolReady = useRequirePierreWorkerPool();
  if (!isWorkerPoolReady) {
    return <DiffLoadingSkeleton />;
  }
  return (
    <div
      ref={containerRef}
      className={cn("overflow-x-auto", className)}
      onPointerDownCapture={lineSelectionActions.onPointerDownCapture}
      onPointerMoveCapture={lineSelectionActions.onPointerMoveCapture}
      onPointerUpCapture={lineSelectionActions.onPointerUpCapture}
    >
      <div className="w-full max-w-full" style={DIFF_VIEW_STYLE}>
        <PierreWorkerPoolBoundary>
          <DiffView<ExperimentalDiffLineAnnotation>
            fileDiff={resolvedFile}
            options={options}
            selectedLines={lineSelectionActions.selectedRange}
            lineAnnotations={pierreAnnotations}
            renderAnnotation={
              renderLineAnnotation === undefined
                ? undefined
                : renderPierreAnnotation
            }
          />
        </PierreWorkerPoolBoundary>
      </div>
      {lineSelectionActions.menu}
    </div>
  );
}

export default BbDiff;
