import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodebaseIndex, IndexedFile } from "@codebase-copilot/rag";

/** An error whose message is safe and useful to show to the calling model or user. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface ToolLimits {
  /** Lines returned by one get_file_snippet call. */
  maxSnippetLines: number;
  /** Largest file any tool will read from disk. */
  maxFileBytes: number;
  /** Upper bound for k / result counts. */
  maxResults: number;
  /** Upper bound for find_references results. */
  maxReferences: number;
  /** Lines of code included per search hit. */
  maxLinesPerHit: number;
}

export const DEFAULT_LIMITS: ToolLimits = {
  maxSnippetLines: 400,
  maxFileBytes: 1_000_000,
  maxResults: 25,
  maxReferences: 200,
  maxLinesPerHit: 60,
};

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves a model-supplied path to a file that is (a) inside the indexed root and (b) part of
 * the index. Rejects absolute paths, drive letters, NUL bytes and `..` escapes lexically, then
 * re-checks with `realpath` so a symlink inside the root cannot point outside it. Restricting
 * reads to indexed files also keeps `.env`, `.git/` and ignored files out of reach.
 */
export async function resolveIndexedFile(
  index: CodebaseIndex,
  requested: string,
  limits: ToolLimits = DEFAULT_LIMITS,
): Promise<{ file: IndexedFile; absolutePath: string }> {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new ToolInputError("path must be a non-empty string");
  }
  if (requested.includes("\0")) throw new ToolInputError("path contains a NUL byte");
  const cleaned = requested.trim().replace(/\\/g, "/");
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned) || path.isAbsolute(cleaned)) {
    throw new ToolInputError("path must be relative to the indexed repository root");
  }
  const normalized = path.posix.normalize(cleaned).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ToolInputError("path escapes the indexed repository root");
  }
  const absolutePath = path.resolve(index.root, normalized);
  if (!isInside(index.root, absolutePath)) {
    throw new ToolInputError("path escapes the indexed repository root");
  }
  const file = index.getFile(normalized);
  if (!file) {
    throw new ToolInputError(
      `${normalized} is not an indexed file (use search_code or the files resource)`,
    );
  }
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([
      fs.realpath(index.root),
      fs.realpath(absolutePath),
    ]);
  } catch {
    throw new ToolInputError(`${normalized} no longer exists on disk; rebuild the index`);
  }
  if (!isInside(realRoot, realTarget)) {
    throw new ToolInputError("path resolves outside the indexed repository root");
  }
  const stat = await fs.stat(realTarget);
  if (stat.size > limits.maxFileBytes) {
    throw new ToolInputError(`${normalized} is larger than the ${limits.maxFileBytes}-byte limit`);
  }
  return { file, absolutePath: realTarget };
}

export async function readIndexedFile(
  index: CodebaseIndex,
  requested: string,
  limits: ToolLimits = DEFAULT_LIMITS,
): Promise<{ file: IndexedFile; lines: string[] }> {
  const { file, absolutePath } = await resolveIndexedFile(index, requested, limits);
  const content = (await fs.readFile(absolutePath, "utf8")).replace(/\r\n/g, "\n");
  return { file, lines: content.split("\n") };
}
