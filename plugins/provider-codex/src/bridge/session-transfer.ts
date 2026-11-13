import { open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const ROLLOUT_NAME_PATTERN =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([A-Za-z0-9][A-Za-z0-9-]*)\.jsonl$/u;
const FIRST_LINE_CHUNK_BYTES = 64 * 1024;
const FIRST_LINE_MAX_BYTES = 8 * 1024 * 1024;

export interface CodexSessionFile {
  path: string;
  relativePath: string;
}

interface RolloutEntry {
  path: string;
  sessionId: string;
  startedAt: string;
}

const sessionMetaSchema = z
  .object({
    type: z.literal("session_meta"),
    payload: z
      .object({
        source: z
          .object({
            subagent: z
              .object({
                thread_spawn: z
                  .object({ parent_thread_id: z.string() })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export function codexSessionsDirectory(codexHome: string): string {
  return join(codexHome, "sessions");
}

function requireSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid Codex session id: ${sessionId}`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function collectRollouts(
  directory: string,
  isRoot: boolean,
): Promise<RolloutEntry[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isRoot && isMissing(error)) {
      return [];
    }
    throw new Error(
      `Cannot read Codex sessions folder ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const found: RolloutEntry[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectRollouts(entryPath, false)));
      continue;
    }
    const match = entry.isFile() ? ROLLOUT_NAME_PATTERN.exec(entry.name) : null;
    if (match?.[1] !== undefined && match[2] !== undefined) {
      found.push({ path: entryPath, sessionId: match[2], startedAt: match[1] });
    }
  }
  return found;
}

async function readFirstLine(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < FIRST_LINE_MAX_BYTES) {
      const chunk = Buffer.alloc(FIRST_LINE_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      const slice = chunk.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        break;
      }
      chunks.push(slice);
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readParentSessionId(path: string): Promise<string | null> {
  let line: string;
  try {
    line = await readFirstLine(path);
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const meta = sessionMetaSchema.safeParse(json);
  return meta.success
    ? meta.data.payload.source.subagent.thread_spawn.parent_thread_id
    : null;
}

export async function listCodexSessionFiles(args: {
  codexHome: string;
  sessionId: string;
}): Promise<CodexSessionFile[]> {
  requireSessionId(args.sessionId);
  const sessionsDirectory = codexSessionsDirectory(args.codexHome);
  const rollouts = await collectRollouts(sessionsDirectory, true);
  const own = rollouts.filter(
    (rollout) => rollout.sessionId === args.sessionId,
  );
  if (own.length === 0) {
    return [];
  }
  const selected = new Map<string, RolloutEntry>();
  for (const rollout of own) selected.set(rollout.path, rollout);
  const knownIds = new Set([args.sessionId]);
  const earliest = own
    .map((rollout) => rollout.startedAt)
    .sort()
    .at(0);
  const candidates = rollouts.filter(
    (rollout) =>
      !knownIds.has(rollout.sessionId) &&
      earliest !== undefined &&
      rollout.startedAt >= earliest,
  );
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const candidate of candidates) {
      if (selected.has(candidate.path)) continue;
      const parentId = await readParentSessionId(candidate.path);
      if (parentId !== null && knownIds.has(parentId)) {
        selected.set(candidate.path, candidate);
        knownIds.add(candidate.sessionId);
        discovered = true;
      }
    }
  }
  return [...selected.values()]
    .map((rollout) => ({
      path: rollout.path,
      relativePath: relative(sessionsDirectory, rollout.path)
        .split(sep)
        .join("/"),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
