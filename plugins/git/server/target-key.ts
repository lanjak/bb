import type { WorkspaceDiffTarget } from "../contract.js";

export function targetKey(target: WorkspaceDiffTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "uncommitted";
    case "branch_committed":
    case "all":
      return `${target.type}:${target.mergeBaseBranch}`;
    case "commit":
      return `commit:${target.sha.toLowerCase()}`;
  }
}
