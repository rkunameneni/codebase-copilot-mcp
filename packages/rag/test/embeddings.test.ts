import { embeddingProviderFromEnv } from "../src/embeddings/factory";
import { fnv1a, TfidfEmbeddingProvider } from "../src/embeddings/tfidf";
import { VoyageEmbeddingProvider } from "../src/embeddings/voyage";
import { cosineSimilarity, norm } from "../src/store/vectorStore";

const CORPUS = [
  "cancelOrder releases inventory and refunds the payment",
  "reserve stock for a sku in the inventory service",
  "calculate order total with loyalty discount",
];

describe("TfidfEmbeddingProvider", () => {
  it("produces deterministic, L2-normalized vectors", async () => {
    const a = new TfidfEmbeddingProvider();
    const b = new TfidfEmbeddingProvider();
    a.fit(CORPUS);
    b.fit(CORPUS);
    const [va] = await a.embedDocuments([CORPUS[0] as string]);
    const [vb] = await b.embedDocuments([CORPUS[0] as string]);
    expect(va).toEqual(vb);
    expect(norm(va as number[])).toBeCloseTo(1, 10);
    expect(fnv1a("abc")).toBe(0x1a47e90b);
  });

  it("places related text closer than unrelated text", async () => {
    const provider = new TfidfEmbeddingProvider();
    provider.fit(CORPUS);
    const docs = await provider.embedDocuments(CORPUS);
    const query = await provider.embedQuery("refund when an order is cancelled");
    const sims = docs.map((d) => cosineSimilarity(query, d));
    expect(sims[0]).toBeGreaterThan(sims[1] as number);
    expect(sims[0]).toBeGreaterThan(sims[2] as number);
  });

  it("matches morphological variants through character trigrams", async () => {
    const withTrigrams = new TfidfEmbeddingProvider();
    const wordsOnly = new TfidfEmbeddingProvider({ trigramWeight: 0 });
    for (const p of [withTrigrams, wordsOnly]) p.fit(CORPUS);
    const sim = async (p: TfidfEmbeddingProvider) =>
      cosineSimilarity(await p.embedQuery("cancellation"), await p.embedQuery("cancelOrder"));
    expect(await sim(wordsOnly)).toBeCloseTo(0, 10);
    expect(await sim(withTrigrams)).toBeGreaterThan(0.2);
  });

  it("round-trips its state so queries embed identically after reload", async () => {
    const original = new TfidfEmbeddingProvider({ dimensions: 256 });
    original.fit(CORPUS);
    const restored = new TfidfEmbeddingProvider();
    restored.importState(JSON.parse(JSON.stringify(original.exportState())));
    expect(restored.id).toBe(original.id);
    expect(await restored.embedQuery("inventory")).toEqual(await original.embedQuery("inventory"));
    expect(() => restored.importState({ dimensions: 4 })).toThrow(/Invalid/);
  });

  it("returns a zero vector for text without tokens", async () => {
    const provider = new TfidfEmbeddingProvider({ dimensions: 16 });
    expect(await provider.embedQuery("?? !!")).toEqual(new Array(16).fill(0));
  });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("VoyageEmbeddingProvider", () => {
  it("batches requests, sends input_type and restores input order", async () => {
    const calls: { input: string[]; input_type: string; model: string }[] = [];
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        input: string[];
        input_type: string;
        model: string;
      };
      calls.push(body);
      const data = body.input
        .map((text, index) => ({ index, embedding: [text.length, index] }))
        .reverse();
      return jsonResponse({ data });
    }) as unknown as typeof fetch;
    const provider = new VoyageEmbeddingProvider({ apiKey: "test-key", batchSize: 2, fetchImpl });
    const vectors = await provider.embedDocuments(["a", "bb", "ccc"]);
    expect(vectors).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    expect(calls.map((c) => c.input)).toEqual([["a", "bb"], ["ccc"]]);
    expect(calls.every((c) => c.input_type === "document" && c.model === "voyage-code-3")).toBe(
      true,
    );
    await provider.embedQuery("q");
    expect(calls[2]?.input_type).toBe("query");
    expect(provider.id).toBe("voyage:voyage-code-3");
  });

  it("retries 429 responses and honours retry-after", async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ error: "rate limited" }, 429, { "retry-after": "2" })
        : jsonResponse({ data: [{ index: 0, embedding: [0.5] }] });
    }) as unknown as typeof fetch;
    const provider = new VoyageEmbeddingProvider({
      apiKey: "k",
      fetchImpl,
      retry: { sleep: async (ms) => void sleeps.push(ms) },
    });
    expect(await provider.embedQuery("hello")).toEqual([0.5]);
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry client errors", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ error: "bad key" }, 401),
    ) as unknown as typeof fetch;
    const provider = new VoyageEmbeddingProvider({
      apiKey: "k",
      fetchImpl,
      retry: { sleep: async () => {} },
    });
    await expect(provider.embedQuery("x")).rejects.toThrow(/HTTP 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires an API key", () => {
    expect(() => new VoyageEmbeddingProvider({ apiKey: "" })).toThrow(/API key/);
  });
});

describe("embeddingProviderFromEnv", () => {
  it("defaults to the local provider and validates the voyage configuration", () => {
    expect(embeddingProviderFromEnv({}).id).toMatch(/^tfidf-hash-v1/);
    expect(() => embeddingProviderFromEnv({ COPILOT_EMBEDDINGS: "voyage" })).toThrow(
      /VOYAGE_API_KEY/,
    );
    expect(embeddingProviderFromEnv({ COPILOT_EMBEDDINGS: "voyage", VOYAGE_API_KEY: "k" }).id).toBe(
      "voyage:voyage-code-3",
    );
    expect(() => embeddingProviderFromEnv({ COPILOT_EMBEDDINGS: "other" })).toThrow(/Unknown/);
  });
});
