import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface LoadedPrompt {
  /** e.g. `review.system` */
  id: string;
  version: number;
  /** Short content hash, logged alongside outputs so results are traceable to exact prompt text. */
  sha: string;
  body: string;
  metadata: Record<string, string>;
}

/**
 * Finds the repository's `prompts/` directory: `COPILOT_PROMPTS_DIR` if set, otherwise the first
 * `prompts/` found walking up from this module (works from `src/` under ts-jest and from `dist/`).
 */
export function resolvePromptsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COPILOT_PROMPTS_DIR) return path.resolve(env.COPILOT_PROMPTS_DIR);
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, "prompts");
    if (existsSync(path.join(candidate, "README.md"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the prompts/ directory; set COPILOT_PROMPTS_DIR");
}

export function parsePromptFile(raw: string): { metadata: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { metadata: {}, body: text.trim() };
  const metadata: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { metadata, body: text.slice(match[0].length).trim() };
}

/**
 * Loads `prompts/<id>.v<N>.md`. Without `version`, the highest available version is used, so a
 * new prompt version is adopted by adding a file, and an old one can be pinned for comparison.
 */
export function loadPrompt(
  id: string,
  options: { version?: number; dir?: string } = {},
): LoadedPrompt {
  const dir = options.dir ?? resolvePromptsDir();
  const pattern = new RegExp(`^${id.replace(/\./g, "\\.")}\\.v(\\d+)\\.md$`);
  const versions = readdirSync(dir)
    .map((name) => pattern.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  const version = options.version ?? versions[0];
  if (version === undefined || !versions.includes(version)) {
    throw new Error(
      `Prompt ${id}${options.version ? ` v${options.version}` : ""} not found in ${dir}`,
    );
  }
  const raw = readFileSync(path.join(dir, `${id}.v${version}.md`), "utf8");
  const { metadata, body } = parsePromptFile(raw);
  return {
    id,
    version,
    sha: createHash("sha256").update(body).digest("hex").slice(0, 12),
    body,
    metadata,
  };
}

/** Replaces `{{name}}` placeholders; unknown placeholders are an error rather than silent. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing prompt variable: ${name}`);
    return value;
  });
}
