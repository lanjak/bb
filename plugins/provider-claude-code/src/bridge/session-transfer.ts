import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { findTranscriptProjectDirectory } from "./session-fork.js";

const MAX_PROJECT_FOLDER_NAME_LENGTH = 200;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface ClaudeSessionFile {
  path: string;
  relativePath: string;
}

function javaStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

export function claudeProjectFolderName(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/gu, "-");
  if (encoded.length <= MAX_PROJECT_FOLDER_NAME_LENGTH) {
    return encoded;
  }
  return `${encoded.slice(0, MAX_PROJECT_FOLDER_NAME_LENGTH)}-${Math.abs(javaStringHash(cwd)).toString(36)}`;
}

export function claudeSessionDestination(args: {
  configDirectory: string;
  cwd: string;
}): string {
  return join(
    args.configDirectory,
    "projects",
    claudeProjectFolderName(args.cwd),
  );
}

function requireSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid Claude session id: ${sessionId}`);
  }
}

async function collectRegularFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectRegularFiles(entryPath)));
    } else if (entry.isFile()) {
      found.push(entryPath);
    }
  }
  return found;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function listClaudeSessionFiles(args: {
  configDirectory: string;
  cwd: string;
  sessionId: string;
}): Promise<ClaudeSessionFile[]> {
  requireSessionId(args.sessionId);
  const projectDirectory = await findTranscriptProjectDirectory({
    projectsDirectory: join(args.configDirectory, "projects"),
    sessionId: args.sessionId,
    preferredProjectFolderName: claudeProjectFolderName(args.cwd),
  });
  if (projectDirectory === null) {
    return [];
  }
  const transcriptPath = join(projectDirectory, `${args.sessionId}.jsonl`);
  const sidecarPaths = await collectRegularFiles(
    join(projectDirectory, args.sessionId),
  ).catch(() => []);
  const paths = [transcriptPath, ...sidecarPaths.sort()];
  const files: ClaudeSessionFile[] = [];
  for (const filePath of paths) {
    if (await isRegularFile(filePath)) {
      files.push({
        path: filePath,
        relativePath: relative(projectDirectory, filePath).split(sep).join("/"),
      });
    }
  }
  return files;
}
