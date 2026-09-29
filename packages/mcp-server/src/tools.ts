import type { Chunk, CodebaseIndex } from "@codebase-copilot/rag";
import { z } from "zod";
import {
  DEFAULT_LIMITS,
  readIndexedFile,
  resolveIndexedFile,
  ToolInputError,
  type ToolLimits,
} from "./security";
import {
  declarationLine,
  extractDoc,
  findDefinitions,
  findReferences,
  parseSymbol,
} from "./symbols";
import { suggestTests } from "./testgen";

export interface ToolContext {
  index: CodebaseIndex;
  limits: ToolLimits;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  handler: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
}

function defineTool<S extends z.ZodObject>(tool: ToolDefinition<S>): ToolDefinition<S> {
  return tool;
}

export function createContext(index: CodebaseIndex, limits: Partial<ToolLimits> = {}): ToolContext {
  return { index, limits: { ...DEFAULT_LIMITS, ...limits } };
}

const location = (c: Pick<Chunk, "filePath" | "startLine" | "endLine">) =>
  `${c.filePath}:${c.startLine}-${c.endLine}`;

function clipText(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

const LANGUAGES = [
  "java",
  "typescript",
  "javascript",
  "kotlin",
  "python",
  "markdown",
  "xml",
  "json",
  "yaml",
  "properties",
  "sql",
  "text",
] as const;

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .describe("File path relative to the repository root, e.g. src/main/java/com/acme/Foo.java");

const symbolName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*(?:\(\))?$/,
    "must be an identifier such as OrderService or OrderService.cancelOrder",
  )
  .describe("Symbol name: Class, method, or Class.method");

export const searchCodeTool = defineTool({
  name: "search_code",
  title: "Search code",
  description:
    "Hybrid (BM25 + vector) search over the indexed repository. Returns the most relevant code chunks with file:line locations, symbol names and a confidence assessment. Use this first to find where something is implemented; if confidence.lowConfidence is true, the code base probably does not contain what was asked for.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe("Natural-language question or identifiers to search for"),
    k: z.number().int().min(1).max(25).default(8).describe("Number of results (1-25)"),
    language: z.enum(LANGUAGES).optional().describe("Only return chunks in this language"),
    pathPrefix: z
      .string()
      .max(300)
      .optional()
      .describe("Only return chunks under this path prefix"),
    mode: z.enum(["hybrid", "bm25", "vector"]).default("hybrid").describe("Retrieval strategy"),
  }),
  handler: async (ctx, input) => {
    const result = await ctx.index.search(input.query, {
      k: Math.min(input.k, ctx.limits.maxResults),
      mode: input.mode,
      ...(input.language ? { language: input.language } : {}),
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    });
    return {
      query: result.query,
      mode: result.mode,
      confidence: result.confidence,
      results: result.hits.map((h) => {
        const clipped = clipText(h.chunk.text, ctx.limits.maxLinesPerHit);
        return {
          location: location(h.chunk),
          kind: h.chunk.kind,
          symbol: h.chunk.symbol ?? null,
          container: h.chunk.container ?? null,
          score: Number(h.score.toFixed(5)),
          bm25Rank: h.bm25Rank,
          vectorRank: h.vectorRank,
          code: clipped.text,
          truncated: clipped.truncated,
        };
      }),
    };
  },
});

export const getFileSnippetTool = defineTool({
  name: "get_file_snippet",
  title: "Get file snippet",
  description:
    "Returns numbered lines from an indexed file. Paths are relative to the repository root; only indexed files can be read and at most 400 lines are returned per call.",
  inputSchema: z.object({
    path: relativePath,
    startLine: z.number().int().min(1).default(1).describe("First line (1-based, inclusive)"),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Last line (inclusive); defaults to startLine + 99"),
  }),
  handler: async (ctx, input) => {
    const { file, lines } = await readIndexedFile(ctx.index, input.path, ctx.limits);
    const totalLines = lines.length;
    if (input.startLine > totalLines) {
      throw new ToolInputError(`${file.path} has only ${totalLines} lines`);
    }
    const requestedEnd = input.endLine ?? input.startLine + 99;
    if (requestedEnd < input.startLine) throw new ToolInputError("endLine must be >= startLine");
    const endLine = Math.min(
      totalLines,
      requestedEnd,
      input.startLine + ctx.limits.maxSnippetLines - 1,
    );
    const width = String(endLine).length;
    const content = lines
      .slice(input.startLine - 1, endLine)
      .map((line, i) => `${String(input.startLine + i).padStart(width)}| ${line}`)
      .join("\n");
    return {
      path: file.path,
      startLine: input.startLine,
      endLine,
      totalLines,
      truncated: endLine < Math.min(totalLines, requestedEnd),
      content,
    };
  },
});

export const explainSymbolTool = defineTool({
  name: "explain_symbol",
  title: "Explain symbol",
  description:
    "Looks up where a class, method or function is defined and returns what is needed to explain it: signature, doc comment, source, enclosing class, members (for classes) and how often it is referenced. Accepts Class, method or Class.method.",
  inputSchema: z.object({
    symbol: symbolName,
    path: relativePath.optional().describe("Restrict to definitions in this file"),
  }),
  handler: async (ctx, input) => {
    const query = parseSymbol(input.symbol);
    if (input.path) await resolveIndexedFile(ctx.index, input.path, ctx.limits);
    const definitions = findDefinitions(ctx.index, query, input.path);
    if (definitions.length === 0) {
      const lower = query.name.toLowerCase();
      const suggestions = [
        ...new Set(
          ctx.index.chunks
            .filter((c) => c.symbol && c.symbol.toLowerCase().includes(lower))
            .map((c) => (c.container ? `${c.container}.${c.symbol}` : (c.symbol as string))),
        ),
      ].slice(0, 10);
      return { symbol: input.symbol, found: false, suggestions };
    }
    const { total } = await findReferences(ctx.index, query, ctx.limits, 0);
    return {
      symbol: input.symbol,
      found: true,
      referenceCount: total,
      definitions: definitions.slice(0, 5).map((c) => {
        const clipped = clipText(c.text, ctx.limits.maxLinesPerHit);
        const members =
          c.kind === "class"
            ? ctx.index
                .chunksForFile(c.filePath)
                .filter((m) => m.container === c.symbol && m.signature && m.kind !== "class")
                .map((m) => ({ signature: m.signature, location: location(m) }))
            : undefined;
        return {
          location: location(c),
          declarationLine: declarationLine(c),
          kind: c.kind,
          container: c.container ?? null,
          signature: c.signature ?? null,
          doc: extractDoc(c) ?? null,
          code: clipped.text,
          truncated: clipped.truncated,
          ...(members ? { members } : {}),
        };
      }),
    };
  },
});

export const findReferencesTool = defineTool({
  name: "find_references",
  title: "Find references",
  description:
    "Finds whole-word occurrences of a symbol across all indexed files and returns file:line locations with the matching line. Lexical, so same-named symbols in unrelated classes are included; declaration lines are excluded unless includeDefinitions is true.",
  inputSchema: z.object({
    symbol: symbolName,
    limit: z.number().int().min(1).max(200).default(50).describe("Maximum references returned"),
    includeDefinitions: z.boolean().default(false),
  }),
  handler: async (ctx, input) => {
    const query = parseSymbol(input.symbol);
    const limit = Math.min(input.limit, ctx.limits.maxReferences);
    const { references, total } = await findReferences(
      ctx.index,
      query,
      ctx.limits,
      limit,
      input.includeDefinitions,
    );
    return {
      symbol: input.symbol,
      searchedFor: query.name,
      total,
      truncated: total > references.length,
      references,
    };
  },
});

export const suggestTestsTool = defineTool({
  name: "suggest_tests",
  title: "Suggest tests",
  description:
    "Generates a unit-test skeleton for one method: JUnit 5 + Mockito for Java (collaborator fields become @Mock) or Jest for TypeScript/JavaScript. Scenarios come from the code itself: the happy path, each exception the method throws, boolean branches and explicit null guards. The skeleton compiles against the method's real signature but its assertions are starting points to refine.",
  inputSchema: z.object({
    path: relativePath,
    method: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_$][\w$]*$/, "must be a method name")
      .describe("Method or function name"),
    framework: z
      .enum(["junit", "jest"])
      .optional()
      .describe("Defaults to junit for Java and jest otherwise"),
  }),
  handler: async (ctx, input) => {
    const { file } = await resolveIndexedFile(ctx.index, input.path, ctx.limits);
    const candidates = ctx.index
      .chunksForFile(file.path)
      .filter(
        (c) => c.symbol === input.method && ["method", "function", "constructor"].includes(c.kind),
      );
    const chunk = candidates[0];
    if (!chunk) {
      const available = ctx.index
        .chunksForFile(file.path)
        .filter((c) => c.kind === "method" || c.kind === "function")
        .map((c) => c.symbol);
      throw new ToolInputError(
        `No method named ${input.method} in ${file.path}. Available: ${available.join(", ") || "none"}`,
      );
    }
    const suggestion = suggestTests(ctx.index, chunk, input.framework);
    return { target: location(chunk), ...suggestion };
  },
});

/** The tool surface shared by the MCP server and the review agent. */
export const TOOLS = [
  searchCodeTool,
  getFileSnippetTool,
  explainSymbolTool,
  findReferencesTool,
  suggestTestsTool,
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export interface ToolCallResult {
  ok: boolean;
  /** JSON (on success) or an error message (on failure), ready to send back to a model. */
  text: string;
  data?: unknown;
}

/**
 * Validates raw (model-supplied) input against the tool's zod schema and runs the handler.
 * Never throws: invalid input and handler errors become `{ ok: false }` results so an agent can
 * read the message and correct itself.
 */
export async function callTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<ToolCallResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, text: `Unknown tool: ${name}` };
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return { ok: false, text: `Invalid input for ${name}: ${issues}` };
  }
  try {
    // The cast is safe: `parsed.data` was produced by this tool's own schema.
    const data = await (tool.handler as (c: ToolContext, i: unknown) => Promise<unknown>)(
      ctx,
      parsed.data,
    );
    return { ok: true, text: JSON.stringify(data, null, 2), data };
  } catch (error) {
    if (error instanceof ToolInputError) return { ok: false, text: error.message };
    return {
      ok: false,
      text: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
