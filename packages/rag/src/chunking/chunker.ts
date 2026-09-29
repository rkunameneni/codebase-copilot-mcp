import {
  STRUCTURED_LANGUAGES,
  type Chunk,
  type ChunkKind,
  type Language,
  type SourceFile,
} from "../types";
import { depthAtLineStart, maskCode, matchBraces } from "./lexer";

export interface ChunkOptions {
  /** Structural chunks longer than this are split into overlapping windows (default 80). */
  maxChunkLines?: number;
  /** Window size for the sliding-window fallback (default 40). */
  windowLines?: number;
  /** Overlap between consecutive windows (default 8). */
  windowOverlap?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  maxChunkLines: 80,
  windowLines: 40,
  windowOverlap: 8,
};

interface SymbolSpan {
  kind: Exclude<ChunkKind, "block" | "window">;
  name: string;
  container?: string;
  /** 0-based line of the declaration keyword. */
  declLine: number;
  /** 0-based first line including leading doc comments and annotations. */
  start: number;
  /** 0-based line of the closing brace. */
  end: number;
  signature: string;
}

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "else",
  "throw",
  "case",
  "do",
  "try",
  "finally",
  "synchronized",
  "function",
  "typeof",
  "await",
  "yield",
  "super",
  "this",
]);

const CLASS_RE = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;
const JAVA_MEMBER_RE =
  /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]*>\s*)?([\w$.<>[\]?,\s]+?)\s+([A-Za-z_$][\w$]*)\s*\(/;
const JAVA_CONSTRUCTOR_RE = /^\s*(?:(?:public|protected|private)\s+)?([A-Z][\w$]*)\s*\(/;
const TS_MEMBER_RE =
  /^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set|declare)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const TS_FUNCTION_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TS_ARROW_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * Starting at `line`/`column`, find the body brace of a declaration. Braces inside parentheses
 * (default parameter values, annotation arguments) are skipped. Returns undefined when a `;`
 * arrives first, i.e. the declaration has no body (abstract/interface method, field, call).
 */
function findBodyBrace(
  masked: string[],
  line: number,
  column: number,
  maxLookahead = 8,
): { line: number; column: number } | undefined {
  let parenDepth = 0;
  for (let l = line; l < Math.min(masked.length, line + maxLookahead); l++) {
    const text = masked[l] as string;
    for (let c = l === line ? column : 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (parenDepth === 0 && ch === ";") return undefined;
      else if (parenDepth === 0 && ch === "{") return { line: l, column: c };
    }
  }
  return undefined;
}

function isDocOrAnnotation(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("@") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("//") ||
    t.endsWith("*/")
  );
}

function docStart(lines: string[], declLine: number, floor: number): number {
  let start = declLine;
  while (start - 1 > floor && isDocOrAnnotation(lines[start - 1] as string)) start -= 1;
  return start;
}

function signatureOf(
  lines: string[],
  masked: string[],
  declLine: number,
  braceLine: number,
): string {
  const parts: string[] = [];
  for (let l = declLine; l <= braceLine; l++) {
    let text = lines[l] as string;
    if (l === braceLine) {
      const cut = (masked[l] as string).indexOf("{");
      if (cut >= 0) text = text.slice(0, cut);
    }
    parts.push(text.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function detectSymbols(lines: string[], language: Language): SymbolSpan[] {
  const masked = maskCode(lines.join("\n")).split("\n");
  const braces = matchBraces(masked);
  const depths = depthAtLineStart(masked);
  const isJava = language === "java";
  const symbols: SymbolSpan[] = [];
  const classStack: { name: string; depth: number; end: number }[] = [];
  let insideCallableUntil = -1;
  let lastEnd = -1;

  const bodyFor = (line: number, column: number) => {
    const brace = findBodyBrace(masked, line, column);
    if (!brace) return undefined;
    const pair = braces.get(`${brace.line}:${brace.column}`);
    return pair ? { braceLine: brace.line, end: pair.closeLine } : undefined;
  };

  for (let i = 0; i < masked.length; i++) {
    while (
      classStack.length > 0 &&
      (classStack[classStack.length - 1] as { end: number }).end < i
    ) {
      classStack.pop();
    }
    if (i <= insideCallableUntil) continue;
    const m = masked[i] as string;
    if (m.trim().length === 0) continue;
    const depth = depths[i] as number;
    const enclosing = classStack[classStack.length - 1];
    const atMemberLevel = enclosing !== undefined && depth === enclosing.depth + 1;
    const atTopLevel = enclosing === undefined;

    const cls = CLASS_RE.exec(m);
    if (cls && (atTopLevel || atMemberLevel)) {
      const body = bodyFor(i, cls.index);
      if (body) {
        const name = cls[2] as string;
        symbols.push({
          kind: "class",
          name,
          container: enclosing?.name,
          declLine: i,
          start: docStart(lines, i, lastEnd),
          end: body.end,
          signature: signatureOf(lines, masked, i, body.braceLine),
        });
        classStack.push({ name, depth, end: body.end });
        continue;
      }
    }

    let callable: { kind: SymbolSpan["kind"]; name: string; index: number } | undefined;
    if (atMemberLevel && enclosing) {
      if (isJava) {
        const ctor = JAVA_CONSTRUCTOR_RE.exec(m);
        const member = JAVA_MEMBER_RE.exec(m);
        if (ctor && ctor[1] === enclosing.name) {
          callable = { kind: "constructor", name: ctor[1], index: ctor.index };
        } else if (member) {
          const returnType = (member[1] as string).trim();
          const name = member[2] as string;
          const firstWord = returnType.split(/\s+/)[0] ?? "";
          if (!KEYWORDS.has(name) && !KEYWORDS.has(firstWord)) {
            callable = { kind: "method", name, index: member.index };
          }
        }
      } else {
        const member = TS_MEMBER_RE.exec(m);
        if (member && !KEYWORDS.has(member[1] as string)) {
          const name = member[1] as string;
          callable = { kind: name === "constructor" ? "constructor" : "method", name, index: 0 };
        }
      }
    } else if (!isJava && (atTopLevel || depth === 0)) {
      const fn = TS_FUNCTION_RE.exec(m) ?? TS_ARROW_RE.exec(m);
      if (fn) callable = { kind: "function", name: fn[1] as string, index: fn.index };
    }

    if (callable) {
      const body = bodyFor(i, callable.index);
      if (body) {
        symbols.push({
          kind: callable.kind,
          name: callable.name,
          container: enclosing?.name,
          declLine: i,
          start: docStart(lines, i, lastEnd),
          end: body.end,
          signature: signatureOf(lines, masked, i, body.braceLine),
        });
        insideCallableUntil = body.end;
        lastEnd = body.end;
      }
    }
  }
  return symbols;
}

function isTrivial(line: string): boolean {
  return /^[\s{}();,]*$/.test(line);
}

function makeChunk(
  file: Pick<SourceFile, "path" | "language">,
  lines: string[],
  start: number,
  end: number,
  kind: ChunkKind,
  meta: { symbol?: string; container?: string; signature?: string } = {},
): Chunk {
  const startLine = start + 1;
  const endLine = end + 1;
  const chunk: Chunk = {
    id: `${file.path}:${startLine}-${endLine}`,
    filePath: file.path,
    language: file.language,
    startLine,
    endLine,
    kind,
    text: lines.slice(start, end + 1).join("\n"),
  };
  if (meta.symbol !== undefined) chunk.symbol = meta.symbol;
  if (meta.container !== undefined) chunk.container = meta.container;
  if (meta.signature !== undefined) chunk.signature = meta.signature;
  return chunk;
}

/** Splits [start, end] (0-based, inclusive) into overlapping windows. */
export function windowRanges(
  start: number,
  end: number,
  size: number,
  overlap: number,
): [number, number][] {
  const ranges: [number, number][] = [];
  const step = Math.max(1, size - overlap);
  for (let s = start; s <= end; s += step) {
    const e = Math.min(end, s + size - 1);
    ranges.push([s, e]);
    if (e === end) break;
  }
  return ranges;
}

function emitRange(
  out: Chunk[],
  file: Pick<SourceFile, "path" | "language">,
  lines: string[],
  start: number,
  end: number,
  kind: ChunkKind,
  meta: { symbol?: string; container?: string; signature?: string },
  opts: Required<ChunkOptions>,
): void {
  if (end - start + 1 <= opts.maxChunkLines) {
    out.push(makeChunk(file, lines, start, end, kind, meta));
    return;
  }
  for (const [s, e] of windowRanges(start, end, opts.windowLines, opts.windowOverlap)) {
    out.push(makeChunk(file, lines, s, e, kind, meta));
  }
}

/** Sliding-window chunking for languages without structural support. */
export function chunkByWindow(file: SourceFile, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const lines = file.content.split("\n");
  const chunks: Chunk[] = [];
  for (const [s, e] of windowRanges(0, lines.length - 1, opts.windowLines, opts.windowOverlap)) {
    if (lines.slice(s, e + 1).every((l) => l.trim().length === 0)) continue;
    chunks.push(makeChunk(file, lines, s, e, "window"));
  }
  return chunks;
}

/**
 * Splits a Java/TypeScript/JavaScript file on class and method boundaries.
 *
 * - every method/constructor/function becomes its own chunk, including its Javadoc/JSDoc and
 *   annotations, tagged with `symbol`, `container` and `signature`
 * - a class chunk holds the declaration and everything before its first member
 * - remaining uncovered code (imports, fields, top-level statements) becomes `block` chunks
 * - anything longer than `maxChunkLines` is split into overlapping windows
 */
export function chunkStructured(file: SourceFile, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const lines = file.content.split("\n");
  const symbols = detectSymbols(lines, file.language);
  const covered = new Array<boolean>(lines.length).fill(false);
  const chunks: Chunk[] = [];

  const callables = symbols.filter((s) => s.kind !== "class");
  const classes = symbols.filter((s) => s.kind === "class");

  for (const s of callables) {
    emitRange(
      chunks,
      file,
      lines,
      s.start,
      s.end,
      s.kind,
      {
        symbol: s.name,
        container: s.container,
        signature: s.signature,
      },
      opts,
    );
    for (let l = s.start; l <= s.end; l++) covered[l] = true;
  }

  for (const cls of classes) {
    const children = symbols.filter((s) => s !== cls && s.start > cls.start && s.end <= cls.end);
    const firstChild = children.reduce((min, s) => Math.min(min, s.start), cls.end + 1);
    let end = Math.min(cls.end, firstChild - 1);
    while (end > cls.start && (lines[end] as string).trim().length === 0) end -= 1;
    const start = cls.start;
    if (covered.slice(start, end + 1).some(Boolean)) continue;
    emitRange(
      chunks,
      file,
      lines,
      start,
      end,
      "class",
      {
        symbol: cls.name,
        container: cls.container,
        signature: cls.signature,
      },
      opts,
    );
    for (let l = start; l <= end; l++) covered[l] = true;
  }

  // Everything not yet covered: imports, fields between methods, top-level statements.
  let runStart = -1;
  const flush = (runEnd: number) => {
    if (runStart < 0) return;
    let s = runStart;
    let e = runEnd;
    while (s <= e && (lines[s] as string).trim().length === 0) s += 1;
    while (e >= s && (lines[e] as string).trim().length === 0) e -= 1;
    const body = lines.slice(s, e + 1);
    if (s <= e && !body.every(isTrivial)) {
      const owner = classes
        .filter((c) => c.start <= s && c.end >= e)
        .sort((a, b) => b.start - a.start)[0];
      emitRange(chunks, file, lines, s, e, "block", { container: owner?.name }, opts);
    }
    runStart = -1;
  };
  for (let l = 0; l < lines.length; l++) {
    if (!covered[l]) {
      if (runStart < 0) runStart = l;
    } else {
      flush(l - 1);
    }
  }
  flush(lines.length - 1);

  return chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

/** Chooses structural chunking for supported languages and windows for everything else. */
export function chunkFile(file: SourceFile, options: ChunkOptions = {}): Chunk[] {
  if (file.content.trim().length === 0) return [];
  return STRUCTURED_LANGUAGES.has(file.language)
    ? chunkStructured(file, options)
    : chunkByWindow(file, options);
}
