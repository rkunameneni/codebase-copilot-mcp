import type { Chunk, CodebaseIndex } from "@codebase-copilot/rag";
import { readIndexedFile, type ToolLimits } from "./security";

export interface SymbolQuery {
  name: string;
  container?: string;
}

/** Accepts `method`, `Class`, `Class.method` or `Class#method`. */
export function parseSymbol(input: string): SymbolQuery {
  const trimmed = input.trim().replace(/\(\)$/, "");
  const parts = trimmed.split(/[.#]/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      container: parts[parts.length - 2] as string,
      name: parts[parts.length - 1] as string,
    };
  }
  return { name: trimmed };
}

/** Chunks that declare the symbol (class, method, constructor or function). */
export function findDefinitions(
  index: CodebaseIndex,
  query: SymbolQuery,
  filePath?: string,
): Chunk[] {
  const byName = index.chunks.filter(
    (c) =>
      c.symbol === query.name &&
      c.kind !== "block" &&
      (filePath === undefined || c.filePath === filePath),
  );
  if (!query.container) return byName;
  const scoped = byName.filter((c) => c.container === query.container);
  // `OrderService.OrderService` style queries name a class, whose chunk has no container.
  if (scoped.length === 0 && query.container === query.name) return byName;
  return scoped;
}

/** Leading Javadoc/JSDoc of a chunk, flattened to plain text. */
export function extractDoc(chunk: Chunk): string | undefined {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(chunk.text);
  if (!match) return undefined;
  const beforeDoc = chunk.text.slice(0, match.index);
  if (beforeDoc.trim().length > 0 && !/^\s*(@\w+(\([^)]*\))?\s*)*$/.test(beforeDoc))
    return undefined;
  return (match[1] as string)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

/** 1-based line of the declaration inside a definition chunk (skips doc comments/annotations). */
export function declarationLine(chunk: Chunk): number {
  const lines = chunk.text.split("\n");
  const name = chunk.symbol ?? "";
  const pattern = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`);
  const idx = lines.findIndex((line) => {
    const t = line.trim();
    return !t.startsWith("*") && !t.startsWith("/") && !t.startsWith("@") && pattern.test(t);
  });
  return chunk.startLine + Math.max(0, idx);
}

export interface Reference {
  location: string;
  filePath: string;
  line: number;
  text: string;
  isDefinition: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word occurrences of a symbol across indexed files, read fresh from disk (through the
 * same path guard as every other file access). Lexical, so it can include same-named symbols
 * from unrelated classes; `isDefinition` marks declaration lines.
 */
export async function findReferences(
  index: CodebaseIndex,
  query: SymbolQuery,
  limits: ToolLimits,
  maxResults: number,
  includeDefinitions = false,
): Promise<{ references: Reference[]; total: number }> {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(query.name)}(?![\\w$])`);
  const definitionLines = new Set(
    findDefinitions(index, { name: query.name }).map((c) => `${c.filePath}:${declarationLine(c)}`),
  );
  const references: Reference[] = [];
  let total = 0;
  for (const file of index.files) {
    if (file.bytes > limits.maxFileBytes) continue;
    const { lines } = await readIndexedFile(index, file.path, limits);
    lines.forEach((text, i) => {
      if (!pattern.test(text)) return;
      const location = `${file.path}:${i + 1}`;
      const isDefinition = definitionLines.has(location);
      if (isDefinition && !includeDefinitions) return;
      total += 1;
      if (references.length >= maxResults) return;
      references.push({
        location,
        filePath: file.path,
        line: i + 1,
        text: text.trim().slice(0, 240),
        isDefinition,
      });
    });
  }
  return { references, total };
}
