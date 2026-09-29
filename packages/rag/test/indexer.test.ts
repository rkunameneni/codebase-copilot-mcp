import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TfidfEmbeddingProvider } from "../src/embeddings/tfidf";
import { CodebaseIndex, openIndex } from "../src/indexer";
import { walkRepository } from "../src/ingest/walker";
import {
  recallAtK,
  reciprocalRank,
  runRetrievalEval,
  type GoldenCase,
} from "../src/eval/retrievalEval";
import { SAMPLE_REPO } from "./helpers";

function tempRepo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "copilot-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("walkRepository", () => {
  it("honours root and nested .gitignore files plus the default ignores", async () => {
    const root = tempRepo({
      ".gitignore": "*.log\nsecret/\n",
      "src/App.java": "class App {}",
      "src/debug.log": "noise",
      "secret/keys.txt": "hidden",
      "node_modules/lib/index.js": "module.exports = 1;",
      ".env": "API_KEY=abc",
      "module/.gitignore": "generated/\n",
      "module/generated/Gen.java": "class Gen {}",
      "module/Keep.java": "class Keep {}",
    });
    const { files } = await walkRepository(root);
    expect(files.map((f) => f.path)).toEqual(["module/Keep.java", "src/App.java"]);
  });

  it("skips binary, oversized and unsupported files and normalizes CRLF", async () => {
    const root = tempRepo({
      "a.java": "class A {\r\n}\r\n",
      "b.java": Buffer.from([0x63, 0x00, 0x64]),
      "c.java": "x".repeat(2048),
      "d.png": "not really a png",
    });
    const { files, skipped } = await walkRepository(root, { maxFileBytes: 1024 });
    expect(files.map((f) => f.path)).toEqual(["a.java"]);
    expect(files[0]?.content).toBe("class A {\n}\n");
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: "b.java", reason: "binary" },
        { path: "c.java", reason: "too-large" },
        { path: "d.png", reason: "unsupported-extension" },
      ]),
    );
  });

  it("stops at maxFiles", async () => {
    const root = tempRepo({ "a.ts": "1", "b.ts": "2", "c.ts": "3" });
    const { files, skipped } = await walkRepository(root, { maxFiles: 2 });
    expect(files).toHaveLength(2);
    expect(skipped).toEqual([{ path: "c.ts", reason: "max-files" }]);
  });
});

describe("CodebaseIndex on the sample repository", () => {
  let index: CodebaseIndex;
  beforeAll(async () => {
    index = await CodebaseIndex.build(SAMPLE_REPO);
  });

  it("indexes source files with language-aware chunks", () => {
    expect(index.files.length).toBeGreaterThan(15);
    expect(
      index.getFile("src/main/java/com/example/orders/service/OrderService.java")?.language,
    ).toBe("java");
    const cancel = index.chunks.find(
      (c) => c.symbol === "cancelOrder" && c.container === "OrderService",
    );
    expect(cancel?.kind).toBe("method");
    expect(index.getChunk(cancel!.id)).toBe(cancel);
  });

  it("finds the implementation for a natural-language question", async () => {
    const result = await index.search("where is stock released when an order is cancelled", {
      k: 5,
    });
    const locations = result.hits.map((h) => `${h.chunk.container}.${h.chunk.symbol}`);
    expect(locations).toContain("OrderService.cancelOrder");
    expect(result.confidence.lowConfidence).toBe(false);
  });

  it("finds exact identifiers through the BM25 leg", async () => {
    const result = await index.search("JdbcOrderSearchRepository searchByCustomer", {
      k: 3,
      mode: "bm25",
    });
    expect(result.hits[0]?.chunk.symbol).toBe("searchByCustomer");
    expect(result.hits[0]?.bm25Rank).toBe(1);
    expect(result.hits[0]?.vectorRank).toBeNull();
    expect(result.confidence.topSimilarity).toBeNull();
  });

  it("flags low confidence for questions the code base cannot answer", async () => {
    const result = await index.search("how are payroll taxes withheld for employees in Canada");
    expect(result.confidence.lowConfidence).toBe(true);
    expect(result.confidence.reason).toMatch(/query terms/);
  });

  it("applies language and path filters", async () => {
    const ts = await index.search("cancel order", { language: "typescript" });
    expect(ts.hits.length).toBeGreaterThan(0);
    expect(ts.hits.every((h) => h.chunk.language === "typescript")).toBe(true);
    const repo = await index.search("order", {
      pathPrefix: "src/main/java/com/example/orders/repository/",
    });
    expect(repo.hits.every((h) => h.chunk.filePath.includes("/repository/"))).toBe(true);
  });

  it("saves and reloads to an index that returns identical results", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "copilot-index-")), "index.json");
    await index.save(file);
    const loaded = await CodebaseIndex.load(file, SAMPLE_REPO);
    const query = "loyalty discount rounding";
    const before = await index.search(query);
    const after = await loaded.search(query);
    expect(after.hits.map((h) => h.chunk.id)).toEqual(before.hits.map((h) => h.chunk.id));
    after.hits.forEach((h, i) => expect(h.similarity).toBeCloseTo(before.hits[i]!.similarity, 5));
    expect(await loaded.isStale()).toBe(false);
  });
});

describe("openIndex", () => {
  it("builds, persists, reloads, and rebuilds when files change", async () => {
    const root = tempRepo({ "src/A.java": "class A {\n  void run() {\n  }\n}\n" });
    const first = await openIndex(root, { persist: true });
    expect(first.source).toBe("built");
    const second = await openIndex(root, { persist: true });
    expect(second.source).toBe("loaded");
    writeFileSync(path.join(root, "src/B.java"), "class B {}\n");
    const third = await openIndex(root, { persist: true });
    expect(third.source).toBe("built");
    expect(third.index.files.map((f) => f.path)).toEqual(["src/A.java", "src/B.java"]);
  });

  it("rejects an index built with a different embedding configuration", async () => {
    const root = tempRepo({ "A.java": "class A {}" });
    const file = path.join(root, "idx.json");
    await (await CodebaseIndex.build(root)).save(file);
    // The saved TF-IDF state (1024 dimensions) replaces the provider's constructor defaults.
    const reloaded = await CodebaseIndex.load(
      file,
      root,
      new TfidfEmbeddingProvider({ dimensions: 64 }),
    );
    expect(reloaded.embedder.id).toBe("tfidf-hash-v1:1024");
    const mismatched = {
      id: "voyage:voyage-code-3",
      minRelevantSimilarity: 0.25,
      embedDocuments: async () => [],
      embedQuery: async () => [],
    };
    await expect(CodebaseIndex.load(file, root, mismatched)).rejects.toThrow(/rebuild the index/);
  });
});

describe("retrieval metrics", () => {
  it("computes recall@k and reciprocal rank", () => {
    const ranked = ["a", "b", "c", "d"];
    expect(recallAtK(ranked, ["b", "d"], 1)).toBe(0);
    expect(recallAtK(ranked, ["b", "d"], 2)).toBe(0.5);
    expect(recallAtK(ranked, ["b", "d"], 4)).toBe(1);
    expect(recallAtK(ranked, [], 3)).toBe(0);
    expect(reciprocalRank(ranked, ["c"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(ranked, ["z"])).toBe(0);
  });

  it("runs golden cases across retrieval modes and scores refusals", async () => {
    const index = await CodebaseIndex.build(SAMPLE_REPO);
    const cases: GoldenCase[] = [
      {
        id: "cancel",
        query: "cancel an order and refund the payment",
        relevant: ["src/main/java/com/example/orders/service/OrderService.java"],
      },
      {
        id: "symbol",
        query: "reserve stock for a sku",
        relevant: ["src/main/java/com/example/orders/service/InventoryService.java#reserve"],
      },
      {
        id: "oos",
        query: "kubernetes helm chart ingress annotations",
        relevant: [],
        expectRefusal: true,
      },
    ];
    const report = await runRetrievalEval(index, cases, { ks: [1, 5] });
    expect(report.modes.map((m) => m.mode)).toEqual(["bm25", "vector", "hybrid"]);
    expect(report.answerable).toBe(2);
    const hybrid = report.modes.find((m) => m.mode === "hybrid")!;
    expect(hybrid.cases).toHaveLength(2);
    expect(hybrid.meanRecall[5]).toBe(1);
    expect(report.refusal.correctRefusals).toBe(1);
    expect(report.refusal.falseRefusals).toBe(0);
  });
});
