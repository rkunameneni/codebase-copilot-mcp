export type Language =
  | "java"
  | "typescript"
  | "javascript"
  | "kotlin"
  | "python"
  | "markdown"
  | "xml"
  | "json"
  | "yaml"
  | "properties"
  | "sql"
  | "text";

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  ".java": "java",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".kt": "kotlin",
  ".py": "python",
  ".md": "markdown",
  ".xml": "xml",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".properties": "properties",
  ".sql": "sql",
  ".txt": "text",
};

/** Languages whose source is split on class/method boundaries instead of fixed windows. */
export const STRUCTURED_LANGUAGES: ReadonlySet<Language> = new Set([
  "java",
  "typescript",
  "javascript",
]);

export type ChunkKind = "class" | "method" | "constructor" | "function" | "block" | "window";

/** A retrievable unit of source code, always traceable back to file:line. */
export interface Chunk {
  /** Stable identifier: `${filePath}:${startLine}-${endLine}`. */
  id: string;
  /** Path relative to the indexed root, always with forward slashes. */
  filePath: string;
  language: Language;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  kind: ChunkKind;
  /** Declared name for class/method/function chunks. */
  symbol?: string;
  /** Enclosing class/interface for members. */
  container?: string;
  /** The declaration line(s), without the body. */
  signature?: string;
  text: string;
}

export interface SourceFile {
  /** Relative, forward-slash path. */
  path: string;
  absolutePath: string;
  language: Language;
  content: string;
  bytes: number;
  sha1: string;
}

export interface IndexedFile {
  path: string;
  language: Language;
  bytes: number;
  lines: number;
  sha1: string;
}
