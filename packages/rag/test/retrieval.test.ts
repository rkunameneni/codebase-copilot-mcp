import { Bm25Index } from "../src/retrieval/bm25";
import { reciprocalRankFusion } from "../src/retrieval/rrf";
import { cosineSimilarity, InMemoryVectorStore } from "../src/store/vectorStore";

describe("Bm25Index", () => {
  const index = new Bm25Index();
  index.add("refund", ["refund", "order", "payment"]);
  index.add("cancel", ["cancel", "order", "order", "status"]);
  index.add("stock", ["reserve", "stock", "sku"]);
  index.add("long", ["order", ...Array.from({ length: 40 }, (_, i) => `filler${i}`)]);

  it("ranks documents containing rare query terms first", () => {
    const results = index.search(["cancel", "order"], 10);
    expect(results[0]?.id).toBe("cancel");
    expect(results.map((r) => r.id)).not.toContain("stock");
  });

  it("gives common terms lower idf than rare terms, and never negative", () => {
    expect(index.idf("order")).toBeLessThan(index.idf("cancel"));
    expect(index.idf("order")).toBeGreaterThan(0);
  });

  it("normalizes by document length", () => {
    const results = index.search(["order"], 10);
    const long = results.find((r) => r.id === "long");
    const refund = results.find((r) => r.id === "refund");
    expect(long!.score).toBeLessThan(refund!.score);
  });

  it("counts duplicate query terms once, honours k and the filter", () => {
    expect(index.search(["refund", "refund"], 10)).toEqual(index.search(["refund"], 10));
    expect(index.search(["order"], 2)).toHaveLength(2);
    expect(index.search(["order"], 10, (id) => id !== "cancel").map((r) => r.id)).not.toContain(
      "cancel",
    );
  });

  it("returns nothing for unknown terms, an empty index or k <= 0", () => {
    expect(index.search(["nonexistent"], 5)).toEqual([]);
    expect(new Bm25Index().search(["order"], 5)).toEqual([]);
    expect(index.search(["order"], 0)).toEqual([]);
  });
});

describe("reciprocalRankFusion", () => {
  it("rewards ids ranked well by both lists", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "b" }, { id: "d" }, { id: "a" }],
    ]);
    expect(fused.map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]).toMatchObject({ id: "b", ranks: [2, 1] });
    expect(fused.find((r) => r.id === "d")?.ranks).toEqual([null, 2]);
  });

  it("computes sum of 1/(k + rank)", () => {
    const [top] = reciprocalRankFusion([[{ id: "x" }], [{ id: "x" }]], { k: 60 });
    expect(top?.score).toBeCloseTo(2 / 61, 10);
  });

  it("applies weights and ignores duplicates within a list", () => {
    const fused = reciprocalRankFusion(
      [
        [{ id: "a" }, { id: "a" }, { id: "b" }],
        [{ id: "b" }, { id: "a" }],
      ],
      { weights: [1, 3] },
    );
    expect(fused[0]?.id).toBe("b");
    expect(fused.find((r) => r.id === "a")?.ranks).toEqual([1, 2]);
  });

  it("breaks ties deterministically by id", () => {
    const fused = reciprocalRankFusion([[{ id: "z" }], [{ id: "m" }]]);
    expect(fused.map((r) => r.id)).toEqual(["m", "z"]);
  });
});

describe("InMemoryVectorStore", () => {
  it("returns nearest neighbours by cosine similarity", () => {
    const store = new InMemoryVectorStore();
    store.add([
      { id: "x", vector: [1, 0, 0] },
      { id: "y", vector: [0.7, 0.7, 0] },
      { id: "z", vector: [0, 0, 1] },
    ]);
    const results = store.search([1, 0.1, 0], 2);
    expect(results.map((r) => r.id)).toEqual(["x", "y"]);
    expect(results[0]?.score).toBeCloseTo(cosineSimilarity([1, 0.1, 0], [1, 0, 0]), 10);
    expect(store.size).toBe(3);
  });

  it("handles zero vectors, filters and k", () => {
    const store = new InMemoryVectorStore();
    store.add([
      { id: "zero", vector: [0, 0] },
      { id: "a", vector: [1, 1] },
    ]);
    expect(store.search([0, 0], 5)).toEqual([]);
    expect(store.search([1, 1], 5, (id) => id !== "a").map((r) => r.id)).toEqual(["zero"]);
    expect(store.search([1, 1], 0)).toEqual([]);
  });

  it("rejects vectors with mismatched dimensions", () => {
    const store = new InMemoryVectorStore();
    store.add([{ id: "a", vector: [1, 2, 3] }]);
    expect(() => store.add([{ id: "b", vector: [1, 2] }])).toThrow(/dimensions/);
  });

  it("stores a copy of each vector", () => {
    const store = new InMemoryVectorStore();
    const vector = [1, 2];
    store.add([{ id: "a", vector }]);
    vector[0] = 99;
    expect(store.get("a")).toEqual([1, 2]);
    expect(store.records()).toEqual([{ id: "a", vector: [1, 2] }]);
  });
});
