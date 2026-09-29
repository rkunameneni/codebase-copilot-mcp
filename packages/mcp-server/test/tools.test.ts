import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodebaseIndex } from "@codebase-copilot/rag";
import { resolveIndexedFile, ToolInputError } from "../src/security";
import { callTool, createContext, TOOLS, type ToolContext } from "../src/tools";

const SAMPLE_REPO = path.resolve(__dirname, "../../../sample-repo");
const ORDER_SERVICE = "src/main/java/com/example/orders/service/OrderService.java";

let ctx: ToolContext;
beforeAll(async () => {
  ctx = createContext(await CodebaseIndex.build(SAMPLE_REPO));
});

async function ok(name: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await callTool(ctx, name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.text}`);
  expect(JSON.parse(result.text)).toEqual(result.data);
  return result.data as Record<string, unknown>;
}

describe("tool registry", () => {
  it("exposes the five codebase tools with descriptions and object schemas", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "search_code",
      "get_file_snippet",
      "explain_symbol",
      "find_references",
      "suggest_tests",
    ]);
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(50);
  });

  it("reports unknown tools and schema violations instead of throwing", async () => {
    expect(await callTool(ctx, "rm_rf", {})).toEqual({ ok: false, text: "Unknown tool: rm_rf" });
    const bad = await callTool(ctx, "search_code", { query: "", k: 500 });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/Invalid input for search_code: query: .*; k: /);
  });
});

describe("search_code", () => {
  it("returns located, ranked chunks with a confidence block", async () => {
    const data = await ok("search_code", { query: "reserve inventory stock for sku", k: 3 });
    const results = data.results as { location: string; symbol: string; container: string }[];
    expect(results).toHaveLength(3);
    const reserve = results.find(
      (r) => r.symbol === "reserve" && r.container === "InventoryService",
    );
    expect(reserve?.location).toMatch(/^src\/main\/java\/.*InventoryService\.java:\d+-\d+$/);
    expect((data.confidence as { lowConfidence: boolean }).lowConfidence).toBe(false);
  });
});

describe("get_file_snippet", () => {
  it("returns numbered lines and clamps to the file length", async () => {
    const data = await ok("get_file_snippet", {
      path: ORDER_SERVICE,
      startLine: 63,
      endLine: 9999,
    });
    expect(data.startLine).toBe(63);
    expect(data.endLine).toBe(data.totalLines);
    expect(String(data.content).split("\n")[0]).toMatch(/^63\| {5}\/\*\*/);
  });

  it("caps the number of lines returned", async () => {
    const small = createContext(ctx.index, { maxSnippetLines: 5 });
    const result = await callTool(small, "get_file_snippet", {
      path: ORDER_SERVICE,
      startLine: 1,
      endLine: 50,
    });
    const data = result.data as { endLine: number; truncated: boolean };
    expect(data.endLine).toBe(5);
    expect(data.truncated).toBe(true);
  });

  it.each([
    ["../package.json", /escapes/],
    ["sample-repo/../../package.json", /escapes|not an indexed file/],
    ["/etc/passwd", /relative/],
    ["C:\\Windows\\win.ini", /relative/],
    ["src/../../README.md", /escapes/],
    [".gitignore", /not an indexed file/],
    ["src/main/java/nope.java", /not an indexed file/],
    ["src/\0main", /NUL/],
  ])("rejects %s", async (p, message) => {
    const result = await callTool(ctx, "get_file_snippet", { path: p });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(message);
  });

  it("rejects start lines beyond the end of the file and inverted ranges", async () => {
    expect(
      (await callTool(ctx, "get_file_snippet", { path: ORDER_SERVICE, startLine: 10_000 })).text,
    ).toMatch(/only \d+ lines/);
    expect(
      (await callTool(ctx, "get_file_snippet", { path: ORDER_SERVICE, startLine: 10, endLine: 5 }))
        .text,
    ).toMatch(/endLine/);
  });
});

/** Symlink creation needs Developer Mode or admin rights on Windows; CI (Linux) always runs this. */
function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "symlink-probe-"));
  try {
    writeFileSync(path.join(dir, "target"), "");
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  }
}

describe("path guard with symlinks", () => {
  (canCreateSymlinks() ? it : it.skip)(
    "refuses an indexed path whose real location is outside the root",
    async () => {
      const outside = mkdtempSync(path.join(os.tmpdir(), "outside-"));
      writeFileSync(path.join(outside, "Secret.java"), "class Secret {}");
      const root = mkdtempSync(path.join(os.tmpdir(), "root-"));
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src/Ok.java"), "class Ok {}");
      const index = await CodebaseIndex.build(root);
      // Swap an indexed file for a symlink after indexing (the walker itself never follows links).
      const target = path.join(root, "src/Ok.java");
      rmSync(target);
      symlinkSync(path.join(outside, "Secret.java"), target);
      await expect(resolveIndexedFile(index, "src/Ok.java")).rejects.toThrow(ToolInputError);
      await expect(resolveIndexedFile(index, "src/Ok.java")).rejects.toThrow(/outside/);
    },
  );
});

describe("explain_symbol", () => {
  it("returns signature, doc, code and reference count for a method", async () => {
    const data = await ok("explain_symbol", { symbol: "OrderService.cancelOrder" });
    expect(data.found).toBe(true);
    const [def] = data.definitions as Record<string, unknown>[];
    expect(def).toMatchObject({
      kind: "method",
      container: "OrderService",
      signature: "public Order cancelOrder(Long orderId)",
    });
    expect(def?.doc).toContain("Cancels an order");
    expect(data.referenceCount).toBeGreaterThanOrEqual(1);
  });

  it("lists members when the symbol is a class", async () => {
    const data = await ok("explain_symbol", { symbol: "PaymentService" });
    const [def] = data.definitions as { members: { signature: string }[] }[];
    expect(def?.members.map((m) => m.signature)).toEqual(
      expect.arrayContaining([
        "public String chargeOrder(Order order)",
        "public void refundOrder(Order order)",
      ]),
    );
  });

  it("suggests close matches when the symbol does not exist", async () => {
    const data = await ok("explain_symbol", { symbol: "refund" });
    expect(data.found).toBe(false);
    expect(data.suggestions).toEqual(expect.arrayContaining(["PaymentService.refundOrder"]));
  });

  it("validates the symbol format", async () => {
    const result = await callTool(ctx, "explain_symbol", { symbol: "a; rm -rf /" });
    expect(result.ok).toBe(false);
  });
});

describe("find_references", () => {
  it("finds call sites and marks definitions only when asked", async () => {
    const data = await ok("find_references", { symbol: "reserve" });
    const refs = data.references as { location: string; isDefinition: boolean }[];
    expect(refs.map((r) => r.location)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/OrderService\.java:\d+$/),
        expect.stringMatching(/InventoryServiceTest\.java:\d+$/),
      ]),
    );
    expect(refs.every((r) => !r.isDefinition)).toBe(true);
    const withDefs = await ok("find_references", { symbol: "reserve", includeDefinitions: true });
    expect((withDefs.references as { isDefinition: boolean }[]).some((r) => r.isDefinition)).toBe(
      true,
    );
  });

  it("respects the limit and reports truncation", async () => {
    const data = await ok("find_references", { symbol: "Order", limit: 3 });
    expect((data.references as unknown[]).length).toBe(3);
    expect(data.truncated).toBe(true);
    expect(data.total as number).toBeGreaterThan(3);
  });
});

describe("suggest_tests", () => {
  it("generates a JUnit 5 + Mockito skeleton for a Java method", async () => {
    const data = await ok("suggest_tests", { path: ORDER_SERVICE, method: "cancelOrder" });
    expect(data.framework).toBe("junit");
    expect(data.testFilePath).toBe(
      "src/test/java/com/example/orders/service/OrderServiceCancelOrderTest.java",
    );
    const code = String(data.code);
    expect(code).toContain("@ExtendWith(MockitoExtension.class)");
    expect(code).toContain("@Mock\n    private OrderRepository orderRepository;");
    expect(code).toContain("@InjectMocks\n    private OrderService orderService;");
    expect(code).toContain("import com.example.orders.exception.OrderNotFoundException;");
    expect(code).toContain(
      "assertThrows(OrderNotFoundException.class, () -> orderService.cancelOrder(orderId));",
    );
    expect(data.collaboratorCalls).toEqual(
      expect.arrayContaining(["paymentService.refundOrder", "inventoryService.release"]),
    );
  });

  it("generates a Jest skeleton for a TypeScript method", async () => {
    const data = await ok("suggest_tests", {
      path: "web/src/orderClient.ts",
      method: "cancelOrder",
    });
    expect(data.framework).toBe("jest");
    expect(data.testFilePath).toBe("web/src/orderClient.test.ts");
    const code = String(data.code);
    expect(code).toContain('import { OrderClient } from "./orderClient";');
    expect(code).toContain('const subject = new OrderClient("baseUrl");');
    expect(code).toContain("await expect(subject.cancelOrder(orderId)).rejects.toThrow(Error);");
  });

  it("explains what is available when the method is missing or the framework does not fit", async () => {
    const missing = await callTool(ctx, "suggest_tests", {
      path: ORDER_SERVICE,
      method: "deleteEverything",
    });
    expect(missing.text).toMatch(/Available: .*placeOrder/);
    const wrong = await callTool(ctx, "suggest_tests", {
      path: ORDER_SERVICE,
      method: "placeOrder",
      framework: "jest",
    });
    expect(wrong.text).toMatch(/Jest skeletons are only generated/);
  });
});
