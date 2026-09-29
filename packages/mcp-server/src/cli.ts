#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { embeddingProviderFromEnv, openIndex } from "@codebase-copilot/rag";
import { createMcpServer } from "./server";

const USAGE = `Usage: codebase-copilot-mcp [--root <dir>] [--index <file>] [--persist]

Starts a Model Context Protocol server on stdio over the given repository.

  --root <dir>     Repository to serve (default: current directory)
  --index <file>   Saved index to load (default: <root>/.copilot-index/index.json)
  --persist        Save the index after building it
  --help           Show this message

Logs go to stderr; stdout carries only MCP protocol messages.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      index: { type: "string" },
      persist: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.error(USAGE);
    return;
  }
  const root = path.resolve(values.root ?? process.cwd());
  const started = Date.now();
  const { index, source } = await openIndex(root, {
    embeddings: embeddingProviderFromEnv(),
    ...(values.index ? { indexPath: path.resolve(values.index) } : {}),
    persist: values.persist,
  });
  console.error(
    `[codebase-copilot] ${source} index for ${root}: ${index.files.length} files, ${index.chunks.length} chunks in ${Date.now() - started} ms`,
  );
  const server = createMcpServer(index);
  await server.connect(new StdioServerTransport());
  console.error("[codebase-copilot] MCP server ready on stdio");
}

main().catch((error: unknown) => {
  console.error(
    `[codebase-copilot] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
