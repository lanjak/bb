import { isAbsolute, relative } from "node:path";
import { z } from "zod";

export const ACP_SESSION_FILES_METHOD = "_bb.dev/session/files";
export const ACP_SESSION_DESTINATION_METHOD = "_bb.dev/session/destination";

const filesResultSchema = z.object({
  files: z.array(z.object({ path: z.string(), relativePath: z.string() })),
});

const destinationResultSchema = z.object({
  root: z.string(),
  directory: z.string(),
});

export interface AcpSessionFile {
  path: string;
  relativePath: string;
}

export interface AcpSessionDestination {
  root: string;
  directory: string;
}

function invalid(method: string, detail: string): Error {
  return new Error(`ACP agent returned an invalid ${method} answer: ${detail}`);
}

function requireAbsolute(method: string, label: string, value: string): void {
  if (value === "" || value.includes("\0") || !isAbsolute(value)) {
    throw invalid(method, `${label} must be an absolute path`);
  }
}

function requireSafeRelative(method: string, value: string): void {
  const unsafe =
    value === "" ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..");
  if (unsafe) {
    throw invalid(
      method,
      `relativePath "${value}" must be a relative path with forward slashes and no empty, "." or ".." segments`,
    );
  }
}

export function decodeAcpSessionFiles(result: unknown): AcpSessionFile[] {
  const parsed = filesResultSchema.safeParse(result);
  if (!parsed.success) {
    throw invalid(
      ACP_SESSION_FILES_METHOD,
      "expected { files: [{ path, relativePath }] }",
    );
  }
  const seen = new Set<string>();
  return parsed.data.files.map((file) => {
    requireAbsolute(ACP_SESSION_FILES_METHOD, "path", file.path);
    requireSafeRelative(ACP_SESSION_FILES_METHOD, file.relativePath);
    if (seen.has(file.relativePath)) {
      throw invalid(
        ACP_SESSION_FILES_METHOD,
        `relativePath "${file.relativePath}" is listed twice`,
      );
    }
    seen.add(file.relativePath);
    return { path: file.path, relativePath: file.relativePath };
  });
}

export function decodeAcpSessionDestination(
  result: unknown,
): AcpSessionDestination {
  const parsed = destinationResultSchema.safeParse(result);
  if (!parsed.success) {
    throw invalid(
      ACP_SESSION_DESTINATION_METHOD,
      "expected { root, directory }",
    );
  }
  const { root, directory } = parsed.data;
  requireAbsolute(ACP_SESSION_DESTINATION_METHOD, "root", root);
  requireAbsolute(ACP_SESSION_DESTINATION_METHOD, "directory", directory);
  const inside = relative(root, directory);
  if (
    inside === ".." ||
    inside.startsWith("../") ||
    inside.startsWith("..\\") ||
    isAbsolute(inside)
  ) {
    throw invalid(
      ACP_SESSION_DESTINATION_METHOD,
      `directory "${directory}" is not inside root "${root}"`,
    );
  }
  return { root, directory };
}
