import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { LANGUAGE_BY_EXTENSION, type Language, type SourceFile } from "../types";

export interface WalkOptions {
  /** Files larger than this are skipped (default 256 KiB). */
  maxFileBytes?: number;
  /** Hard cap on the number of files ingested (default 5000). */
  maxFiles?: number;
  /** Extra gitignore-style patterns applied at the root. */
  extraIgnores?: string[];
}

export interface SkippedFile {
  path: string;
  reason: "too-large" | "binary" | "unsupported-extension" | "max-files" | "symlink";
}

export interface WalkResult {
  files: SourceFile[];
  skipped: SkippedFile[];
}

/** Always excluded, whether or not the repository's .gitignore mentions them. */
export const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  "coverage/",
  ".copilot-index/",
  ".env",
  ".env.*",
  "*.min.js",
  "package-lock.json",
];

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 5000;

interface IgnoreScope {
  /** Directory (relative to root, forward slashes, "" for root) the rules are relative to. */
  base: string;
  rules: Ignore;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function languageForPath(filePath: string): Language | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function isIgnored(scopes: IgnoreScope[], relPath: string, isDir: boolean): boolean {
  for (const scope of scopes) {
    const local = scope.base === "" ? relPath : relPath.slice(scope.base.length + 1);
    if (local.length === 0) continue;
    if (scope.rules.ignores(isDir ? `${local}/` : local)) return true;
  }
  return false;
}

async function readIgnoreFile(dir: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(dir, ".gitignore"), "utf8");
  } catch {
    return undefined;
  }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

/**
 * Walks a repository and returns the text files worth indexing.
 *
 * - honours `.gitignore` files at every directory level, plus {@link DEFAULT_IGNORES}
 * - never follows symlinks (a link could point outside the root)
 * - skips binary files, oversized files and unsupported extensions
 * - returns files sorted by path so indexes are deterministic
 */
export async function walkRepository(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const absoluteRoot = path.resolve(root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];

  const rootRules = ignore().add(DEFAULT_IGNORES);
  if (options.extraIgnores) rootRules.add(options.extraIgnores);

  async function visit(dirRel: string, scopes: IgnoreScope[]): Promise<void> {
    const dirAbs = path.join(absoluteRoot, dirRel);
    const gitignore = await readIgnoreFile(dirAbs);
    const activeScopes =
      gitignore === undefined
        ? scopes
        : [...scopes, { base: dirRel, rules: ignore().add(gitignore) }];

    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPath = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relPath, reason: "symlink" });
        continue;
      }
      const isDir = entry.isDirectory();
      if (isIgnored(activeScopes, relPath, isDir)) continue;

      if (isDir) {
        await visit(relPath, activeScopes);
        continue;
      }
      if (!entry.isFile()) continue;

      const language = languageForPath(entry.name);
      if (!language) {
        skipped.push({ path: relPath, reason: "unsupported-extension" });
        continue;
      }
      if (files.length >= maxFiles) {
        skipped.push({ path: relPath, reason: "max-files" });
        continue;
      }
      const absolutePath = path.join(absoluteRoot, relPath);
      const stat = await fs.stat(absolutePath);
      if (stat.size > maxFileBytes) {
        skipped.push({ path: relPath, reason: "too-large" });
        continue;
      }
      const buffer = await fs.readFile(absolutePath);
      if (looksBinary(buffer)) {
        skipped.push({ path: relPath, reason: "binary" });
        continue;
      }
      const content = buffer.toString("utf8").replace(/\r\n/g, "\n");
      files.push({
        path: relPath,
        absolutePath,
        language,
        content,
        bytes: buffer.length,
        sha1: createHash("sha1").update(buffer).digest("hex"),
      });
    }
  }

  await visit("", [{ base: "", rules: rootRules }]);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}
