import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodebaseIndex } from "@codebase-copilot/rag";
import { createMcpServer, FILES_RESOURCE_URI } from "../src/server";

const SAMPLE_REPO = path.resolve(__dirname, "../../../sample-repo");

describe("MCP server over the protocol", () => {
  let client: Client;

  beforeAll(async () => {
    const index = await CodebaseIndex.build(SAMPLE_REPO);
    const server = createMcpServer(index);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists the tools with JSON Schema inputs and read-only annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "explain_symbol",
        "find_references",
        "get_file_snippet",
        "search_code",
        "suggest_tests",
      ].sort(),
    );
    const search = tools.find((t) => t.name === "search_code");
    expect(search?.inputSchema.type).toBe("object");
    expect(search?.inputSchema.required).toEqual(["query"]);
    expect(search?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns text content", async () => {
    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "apply loyalty discount to subtotal", k: 5 },
    });
    expect(result.isError).toBe(false);
    const [first] = result.content as { type: string; text: string }[];
    const data = JSON.parse(first!.text) as { results: { symbol: string }[] };
    expect(data.results.map((r) => r.symbol)).toContain("applyLoyaltyDiscount");
  });

  it("returns tool errors as isError results", async () => {
    const result = await client.callTool({
      name: "get_file_snippet",
      arguments: { path: "../../etc/passwd" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toMatch(/escapes/);
  });

  it("exposes the indexed-file listing as a resource", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(FILES_RESOURCE_URI);
    const { contents } = await client.readResource({ uri: FILES_RESOURCE_URI });
    const listing = JSON.parse((contents[0] as { text: string }).text) as {
      fileCount: number;
      files: { path: string; chunks: number }[];
    };
    expect(listing.fileCount).toBe(listing.files.length);
    expect(listing.files.find((f) => f.path.endsWith("OrderService.java"))?.chunks).toBeGreaterThan(
      3,
    );
  });
});
