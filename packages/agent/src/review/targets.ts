import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CodebaseIndex } from "@codebase-copilot/rag";
import { readIndexedFile, ToolInputError } from "@codebase-copilot/mcp-server";

const execFileAsync = promisify(execFile);

export interface ReviewTarget {
  /** Human-readable description used in the task prompt, e.g. "the file src/Foo.java". */
  description: string;
  kind: "files" | "diff";
  /** Numbered file contents or an annotated diff. */
  content: string;
  /** Files under review with their current line counts (used to validate findings). */
  files: { path: string; lines: number }[];
}

export interface TargetLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_TARGET_LIMITS: TargetLimits = { maxFiles: 20, maxBytes: 200_000 };

function numbered(lines: readonly string[]): string {
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n");
}

function insideRoot(root: string, absolute: string): string | undefined {
  const rel = path.relative(root, absolute);
  return rel.startsWith("..") || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join("/");
}

/**
 * Converts a user path to a root-relative posix path. Relative paths are tried against the
 * current directory first, then against the root, so both `copilot review src/Foo.java --root repo`
 * and `copilot review repo/src/Foo.java --root repo` work. Anything outside the root is rejected.
 */
function toRootRelative(root: string, input: string, cwd: string): string {
  const fromCwd = insideRoot(root, path.resolve(cwd, input));
  if (fromCwd !== undefined && (fromCwd === "" || existsSync(path.join(root, fromCwd))))
    return fromCwd;
  const fromRoot = path.isAbsolute(input) ? undefined : insideRoot(root, path.resolve(root, input));
  const resolved = fromRoot ?? fromCwd;
  if (resolved === undefined) {
    throw new ToolInputError(`${input} is outside the repository root ${root}`);
  }
  return resolved;
}

/** Review target from files or directories. Only indexed files are reviewed. */
export async function targetFromPaths(
  index: CodebaseIndex,
  inputs: readonly string[],
  options: { cwd?: string; limits?: TargetLimits } = {},
): Promise<ReviewTarget> {
  const limits = options.limits ?? DEFAULT_TARGET_LIMITS;
  const cwd = options.cwd ?? process.cwd();
  const selected = new Set<string>();
  for (const input of inputs) {
    const rel = toRootRelative(index.root, input, cwd);
    if (index.getFile(rel)) {
      selected.add(rel);
      continue;
    }
    const prefix = rel === "" ? "" : `${rel}/`;
    const matches = index.files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
    if (matches.length === 0) throw new ToolInputError(`${input} does not match any indexed file`);
    matches.forEach((m) => selected.add(m));
  }
  const paths = [...selected].sort();
  if (paths.length > limits.maxFiles) {
    throw new ToolInputError(
      `${paths.length} files selected; the limit is ${limits.maxFiles}. Review a narrower path or a diff.`,
    );
  }
  const sections: string[] = [];
  const files: ReviewTarget["files"] = [];
  let bytes = 0;
  for (const p of paths) {
    const { lines } = await readIndexedFile(index, p);
    const section = `=== ${p} (${lines.length} lines) ===\n${numbered(lines)}`;
    bytes += Buffer.byteLength(section);
    if (bytes > limits.maxBytes) {
      throw new ToolInputError(
        `Selected files exceed ${limits.maxBytes} bytes; review a narrower path.`,
      );
    }
    sections.push(section);
    files.push({ path: p, lines: lines.length });
  }
  return {
    description:
      paths.length === 1 ? `the file ${paths[0]}` : `${paths.length} files: ${paths.join(", ")}`,
    kind: "files",
    content: sections.join("\n\n"),
    files,
  };
}

export interface ParsedDiffFile {
  path: string;
  /** Diff rendered with new-file line numbers on added and context lines. */
  rendered: string;
  addedLines: number[];
}

/**
 * Parses a unified diff and annotates each added/context line with its line number in the new
 * file, so the model can cite exact lines. Deleted files are skipped (nothing to point at).
 */
export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: { path: string; out: string[]; added: number[] } | undefined;
  let newLine = 0;
  const flush = () => {
    if (current)
      files.push({
        path: current.path,
        rendered: current.out.join("\n"),
        addedLines: current.added,
      });
    current = undefined;
  };
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = undefined;
        continue;
      }
      current = { path: target.replace(/^b\//, ""), out: [], added: [] };
      continue;
    }
    if (!current || line.startsWith("--- ") || line.startsWith("index ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      current.out.push(`@@ new line ${newLine}${hunk[2] ?? ""}`);
      continue;
    }
    if (line.startsWith("+")) {
      current.out.push(`${String(newLine).padStart(5)} + ${line.slice(1)}`);
      current.added.push(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.out.push(`      - ${line.slice(1)}`);
    } else if (line.startsWith(" ")) {
      current.out.push(`${String(newLine).padStart(5)}   ${line.slice(1)}`);
      newLine += 1;
    }
  }
  flush();
  return files.filter((f) => f.addedLines.length > 0 || f.rendered.length > 0);
}

export async function gitDiff(root: string, base = "HEAD"): Promise<string> {
  if (!/^[\w./~^@{}-]+$/.test(base)) throw new ToolInputError(`Invalid git revision: ${base}`);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "diff", "--no-color", "--unified=3", base, "--"],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return stdout;
}

/** Review target from a unified diff (from `git diff` or a patch file). */
export async function targetFromDiff(
  index: CodebaseIndex,
  diff: string,
  label: string,
  limits: TargetLimits = DEFAULT_TARGET_LIMITS,
): Promise<ReviewTarget> {
  const parsed = parseUnifiedDiff(diff);
  if (parsed.length === 0) throw new ToolInputError("The diff contains no changed files to review");
  if (parsed.length > limits.maxFiles) {
    throw new ToolInputError(
      `The diff touches ${parsed.length} files; the limit is ${limits.maxFiles}`,
    );
  }
  const files: ReviewTarget["files"] = [];
  for (const f of parsed) {
    const indexed = index.getFile(f.path);
    let lines = indexed?.lines;
    const absolute = path.resolve(index.root, f.path);
    const rel = path.relative(index.root, absolute);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ToolInputError(`The diff references a path outside the repository: ${f.path}`);
    }
    if (lines === undefined) {
      try {
        const content = await fs.readFile(absolute, "utf8");
        lines = content.split("\n").length;
      } catch {
        lines = Math.max(0, ...f.addedLines);
      }
    }
    files.push({ path: f.path, lines });
  }
  const content = parsed.map((f) => `=== ${f.path} ===\n${f.rendered}`).join("\n\n");
  if (Buffer.byteLength(content) > limits.maxBytes) {
    throw new ToolInputError(`The diff exceeds ${limits.maxBytes} bytes; review a smaller change`);
  }
  return { description: `the changes in ${label}`, kind: "diff", content, files };
}
