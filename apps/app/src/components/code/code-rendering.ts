import type { ReactNode } from "react";
import type {
  CodeOverflowMode,
  DiffViewMode,
  ExperimentalDiffFullFileContents,
  ExperimentalDiffLineAnnotation,
  SourceCodeLineRange,
} from "@get-bb/plugin-sdk";
import type { ParsedGitDiffFile } from "@bb/shared-ui/git-diff/parsing";
import type { DiffPresentation } from "@bb/shared-ui/git-diff/renderers";
import type {
  CodeLineSelection,
  DiffLineSelection,
  LineSelectionAction,
} from "./line-selection-actions";

export const DEFAULT_CODE_OVERFLOW: CodeOverflowMode = "scroll";
export const DEFAULT_DIFF_VIEW: DiffViewMode = "unified";

interface SourceCodePresentation {
  overflow: CodeOverflowMode;
  highlightedLines: SourceCodeLineRange | null;
}

export interface BbSourceCodeProps extends SourceCodePresentation {
  content: string;
  path: string;
  cacheKey?: string;
  className?: string;
  scrollToHighlightedLines?: boolean;
  selectionActions: readonly LineSelectionAction<CodeLineSelection>[];
}

export interface BbDiffProps extends DiffPresentation {
  file: ParsedGitDiffFile;
  patchText?: string;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  className?: string;
  selectionActions: readonly LineSelectionAction<DiffLineSelection>[];
  lineAnnotations?: readonly ExperimentalDiffLineAnnotation[];
  renderLineAnnotation?: (
    annotation: ExperimentalDiffLineAnnotation,
  ) => ReactNode;
}
