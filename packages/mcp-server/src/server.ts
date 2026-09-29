import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodebaseIndex } from "@codebase-copilot/rag";
import type { ToolLimits } from "./security";
import { callTool, createContext, TOOLS } from "./tools";

export const SERVER_NAME = "codebase-copilot";
export const SERVER_VERSION = "0.1.0";
export const FILES_RESOURCE_URI = "codebase://files";

/**
 * Builds an MCP server over an index. Transport-agnostic: the CLI connects it to stdio, the
 * tests connect it to an in-memory transport.
 */
export function createMcpServer(index: CodebaseIndex, limits: Partial<ToolLimits> = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for exploring one indexed source repository. Start with search_code, then use get_file_snippet, explain_symbol and find_references to read exact code. Cite code as path:line. suggest_tests returns a JUnit/Jest skeleton for a method.",
    },
  );
  const ctx = createContext(index, limits);

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: unknown) => {
        const result = await callTool(ctx, tool.name, args);
        return { content: [{ type: "text" as const, text: result.text }], isError: !result.ok };
      },
    );
  }

  server.registerResource(
    "indexed-files",
    FILES_RESOURCE_URI,
    {
      title: "Indexed files",
      description: "Every file in the index with its language, size, line count and chunk count.",
      mimeType: "application/json",
    },
    async (uri) => {
      const chunkCounts = new Map<string, number>();
      for (const c of index.chunks)
        chunkCounts.set(c.filePath, (chunkCounts.get(c.filePath) ?? 0) + 1);
      const files = index.files.map((f) => ({
        path: f.path,
        language: f.language,
        bytes: f.bytes,
        lines: f.lines,
        chunks: chunkCounts.get(f.path) ?? 0,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ root: index.root, fileCount: files.length, files }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
