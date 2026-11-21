import { useSyncExternalStore } from "react";
import type { GitCommentAnchor, WorkspaceDiffTarget } from "../../contract.js";

export interface CommentDraftLocation {
  path: string;
  revision: string;
  target: WorkspaceDiffTarget;
  anchor: GitCommentAnchor;
  truncated: boolean;
}

export interface CommentDraft extends CommentDraftLocation {
  body: string;
}

const locations = new Map<string, CommentDraftLocation>();
const bodies = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function readCommentDraftBody(environmentId: string): string {
  return bodies.get(environmentId) ?? "";
}

export function readCommentDraft(environmentId: string): CommentDraft | null {
  const location = locations.get(environmentId);
  return location === undefined
    ? null
    : { ...location, body: readCommentDraftBody(environmentId) };
}

export function startCommentDraft(
  environmentId: string,
  location: CommentDraftLocation,
): void {
  locations.set(environmentId, location);
  notify();
}

export function setCommentDraftBody(environmentId: string, body: string): void {
  if (locations.has(environmentId)) bodies.set(environmentId, body);
}

export function discardCommentDraft(environmentId: string): void {
  bodies.delete(environmentId);
  if (locations.delete(environmentId)) notify();
}

export function useCommentDraft(
  environmentId: string,
): CommentDraftLocation | null {
  return useSyncExternalStore(
    subscribe,
    () => locations.get(environmentId) ?? null,
    () => null,
  );
}
