import { glob, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { destinationSchema } from "../target.js";

const MAX_DEPTH = 16;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;

export function userSshConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir(), ".ssh", "config");
}

export function splitConfigLine(line: string): {
  keyword: string;
  values: string[];
} | null {
  const match = /^\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/u.exec(line);
  if (match === null) return null;
  const values: string[] = [];
  for (const token of match[2]!.matchAll(/"([^"]*)"|([^\s"]+)/gu)) {
    const value = token[1] ?? token[2]!;
    if (token[1] === undefined && value.startsWith("#")) break;
    values.push(value);
  }
  return { keyword: match[1]!.toLowerCase(), values };
}

async function includedFiles(
  pattern: string,
  sshDirectory: string,
): Promise<string[]> {
  const expanded = pattern.startsWith("~/")
    ? join(dirname(sshDirectory), pattern.slice(2))
    : pattern;
  const absolute = isAbsolute(expanded)
    ? expanded
    : resolve(sshDirectory, expanded);
  const matches: string[] = [];
  for await (const path of glob(absolute)) {
    matches.push(path);
    if (matches.length >= MAX_FILES) break;
  }
  return matches.sort();
}

export async function listConfigAliases(
  configPath: string,
  limit: number,
): Promise<{ aliases: string[]; truncated: boolean }> {
  const sshDirectory = dirname(configPath);
  const aliases = new Set<string>();
  let files = 0;
  let truncated = false;
  async function read(path: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files >= MAX_FILES) {
      truncated = true;
      return;
    }
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) return;
    if (info.size > MAX_FILE_BYTES) {
      truncated = true;
      return;
    }
    files += 1;
    const text = await readFile(path, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/u)) {
      const parsed = splitConfigLine(line);
      if (parsed === null) continue;
      if (parsed.keyword === "include") {
        for (const pattern of parsed.values)
          for (const file of await includedFiles(pattern, sshDirectory))
            await read(file, depth + 1);
        continue;
      }
      if (parsed.keyword !== "host") continue;
      for (const value of parsed.values) {
        if (/[*?!]/u.test(value) || !destinationSchema.safeParse(value).success)
          continue;
        if (aliases.size >= limit && !aliases.has(value)) {
          truncated = true;
          continue;
        }
        aliases.add(value);
      }
    }
  }
  await read(configPath, 0);
  return { aliases: [...aliases], truncated };
}
