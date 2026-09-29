#!/usr/bin/env node
// End-to-end smoke test of the built MCP server over real stdio: spawns the server process the
// same way Claude Desktop / Claude Code would, then lists tools, calls one and reads the resource.
//
// Usage: npm run build && node scripts/mcp-smoke.mjs
//        node scripts/mcp-smoke.mjs --docker <image>   (runs the server inside the container)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleRepo = path.join(repo, "sample-repo");
const { values } = parseArgs({ options: { docker: { type: "string" } } });
const server = values.docker
  ? {
      command: "docker",
      args: ["run", "-i", "--rm", "-v", `${sampleRepo}:/workspace:ro`, values.docker],
    }
  : {
      command: process.execPath,
      args: [path.join(repo, "packages/mcp-server/dist/cli.js"), "--root", sampleRepo],
    };
console.log(`server: ${server.command} ${server.args.join(" ")}`);
const transport = new StdioClientTransport({ ...server, stderr: "pipe" });
const serverLog = [];
transport.stderr?.on("data", (chunk) => serverLog.push(String(chunk)));

const client = new Client({ name: "smoke-test", version: "1.0.0" });
const fail = (message) => {
  console.error(`FAIL: ${message}\n--- server stderr ---\n${serverLog.join("")}`);
  process.exit(1);
};

const timer = setTimeout(() => fail("timed out after 30 s"), 30_000);
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`tools/list -> ${names.join(", ")}`);
  const expected = [
    "explain_symbol",
    "find_references",
    "get_file_snippet",
    "search_code",
    "suggest_tests",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`unexpected tool list: ${names}`);

  const search = await client.callTool({
    name: "search_code",
    arguments: { query: "cancel order refund", k: 3 },
  });
  if (search.isError) fail(`search_code returned an error: ${search.content[0]?.text}`);
  const results = JSON.parse(search.content[0].text).results;
  console.log(`tools/call search_code -> ${results.map((r) => r.location).join(" | ")}`);

  const guarded = await client.callTool({
    name: "get_file_snippet",
    arguments: { path: "../package.json" },
  });
  if (!guarded.isError) fail("path traversal was not rejected");
  console.log(
    `tools/call get_file_snippet ../package.json -> rejected: ${guarded.content[0].text}`,
  );

  const { contents } = await client.readResource({ uri: "codebase://files" });
  console.log(`resources/read codebase://files -> ${JSON.parse(contents[0].text).fileCount} files`);
  console.log("MCP stdio smoke test passed");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  clearTimeout(timer);
  await client.close();
}
