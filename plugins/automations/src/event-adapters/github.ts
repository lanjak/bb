import { EVENT_DELIVERY_KEY_PATTERN } from "../limits.js";
import type { EventAdapter } from "./types.js";
import {
  hmacSha256,
  INVALID_SIGNATURE,
  parseHex,
  safeEqual,
} from "./signature.js";

const GITHUB_NAME_PATTERN = /^[a-z_]{1,40}$/u;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/iu;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textAt(root: unknown, ...path: string[]): string | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return typeof node === "string" && node !== "" ? node : undefined;
}

function recordAt(root: unknown, ...path: string[]): JsonRecord | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return isRecord(node) ? node : undefined;
}

function arrayAt(root: unknown, ...path: string[]): unknown[] {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node)) return [];
    node = node[key];
  }
  return Array.isArray(node) ? node : [];
}

function pullRequestsComeFromAnotherRepository(
  pullRequests: unknown[],
): boolean {
  return pullRequests.some((entry) => {
    const headId = recordAt(entry, "head", "repo")?.id;
    const baseId = recordAt(entry, "base", "repo")?.id;
    return headId !== undefined && baseId !== undefined && headId !== baseId;
  });
}

type HeadRepository = "same" | "other" | "unknown";

function headRepositoryOf(payload: unknown, event: string): HeadRepository {
  const base = textAt(payload, "repository", "full_name");
  const named = (fullName: string | undefined): HeadRepository =>
    fullName === undefined || base === undefined
      ? "unknown"
      : fullName === base
        ? "same"
        : "other";
  if (event === "pull_request" || event.startsWith("pull_request_")) {
    const head = recordAt(payload, "pull_request", "head");
    if (head === undefined) return "unknown";
    if (head.repo === null) return "other";
    if (recordAt(head, "repo")?.fork === true) return "other";
    return named(textAt(head, "repo", "full_name"));
  }
  if (event === "workflow_run") {
    if (recordAt(payload, "workflow_run", "head_repository")?.fork === true) {
      return "other";
    }
    if (
      pullRequestsComeFromAnotherRepository(
        arrayAt(payload, "workflow_run", "pull_requests"),
      )
    ) {
      return "other";
    }
    return named(
      textAt(payload, "workflow_run", "head_repository", "full_name"),
    );
  }
  if (event === "check_suite" || event === "check_run") {
    const suitePath =
      event === "check_run" ? ["check_run", "check_suite"] : ["check_suite"];
    const pullRequests = arrayAt(
      payload,
      ...(event === "check_run"
        ? ["check_run", "pull_requests"]
        : ["check_suite", "pull_requests"]),
    );
    if (pullRequestsComeFromAnotherRepository(pullRequests)) return "other";
    return named(textAt(payload, ...suitePath, "head_repository", "full_name"));
  }
  return "same";
}

function branchOf(
  payload: unknown,
  event: string,
  head: HeadRepository,
): string | undefined {
  if (event === "push" || event === "create" || event === "delete") {
    const ref = textAt(payload, "ref");
    return ref?.startsWith("refs/heads/") ? ref.slice(11) : ref;
  }
  if (event === "pull_request" || event.startsWith("pull_request_")) {
    return textAt(payload, "pull_request", "base", "ref");
  }
  if (head !== "same") return undefined;
  return (
    textAt(payload, "workflow_run", "head_branch") ??
    textAt(payload, "check_suite", "head_branch") ??
    textAt(payload, "check_run", "check_suite", "head_branch")
  );
}

const UNKNOWN_AUTHOR = "(unknown)";

function loginOf(author: unknown): string | undefined {
  if (!isRecord(author)) return undefined;
  return (
    textAt(author, "login") ?? textAt(author, "username") ?? UNKNOWN_AUTHOR
  );
}

function authorsOf(payload: unknown): string[] {
  const logins = new Set<string>();
  const add = (author: unknown) => {
    const login = loginOf(author);
    if (login !== undefined) logins.add(login);
  };
  add(recordAt(payload, "issue", "user"));
  add(recordAt(payload, "pull_request", "user"));
  add(recordAt(payload, "comment", "user"));
  add(recordAt(payload, "review", "user"));
  add(recordAt(payload, "discussion", "user"));
  add(recordAt(payload, "release", "author"));
  add(recordAt(payload, "head_commit", "author"));
  add(recordAt(payload, "workflow_run", "head_commit", "author"));
  add(recordAt(payload, "check_suite", "head_commit", "author"));
  for (const commit of arrayAt(payload, "commits")) {
    add(recordAt(commit, "author"));
  }
  return [...logins];
}

export const githubAdapter: EventAdapter = {
  source: "github",

  verify(request) {
    const signature = SIGNATURE_PATTERN.exec(
      request.headers.get("x-hub-signature-256") ?? "",
    );
    const expected = hmacSha256(request.secret, request.rawBody);
    const provided = parseHex(signature?.[1] ?? "") ?? Buffer.alloc(0);
    if (!safeEqual(provided, expected)) return INVALID_SIGNATURE;
    const delivery = request.headers.get("x-github-delivery");
    if (delivery === null || !EVENT_DELIVERY_KEY_PATTERN.test(delivery)) {
      return {
        ok: false,
        status: 400,
        error: "X-GitHub-Delivery is missing or malformed",
      };
    }
    const event = request.headers.get("x-github-event");
    if (event === null || !GITHUB_NAME_PATTERN.test(event)) {
      return {
        ok: false,
        status: 400,
        error: "X-GitHub-Event is missing or malformed",
      };
    }
    return { ok: true, deliveryKey: delivery, event };
  },

  deriveKind({ event, payload }) {
    const name = event ?? "unknown";
    const action = textAt(payload, "action");
    return action !== undefined && GITHUB_NAME_PATTERN.test(action)
      ? `${name}.${action}`
      : name;
  },

  isPing({ event }) {
    return event === "ping";
  },

  matchView({ payload, kind }) {
    if (!isRecord(payload)) return payload;
    const event = kind.split(".")[0] ?? kind;
    const derived: Record<string, string | string[]> = {};
    const repo = textAt(payload, "repository", "full_name");
    if (repo !== undefined) derived.repo = repo;
    const actor = textAt(payload, "sender", "login");
    if (actor !== undefined) derived.actor = actor;
    const label = textAt(payload, "label", "name");
    if (label !== undefined) derived.label = label;
    const head = headRepositoryOf(payload, event);
    const branch = branchOf(payload, event, head);
    if (branch !== undefined) derived.branch = branch;
    derived.fork = head === "other" ? "true" : "false";
    derived.authors = authorsOf(payload);
    return { ...payload, _bb: derived };
  },
};
