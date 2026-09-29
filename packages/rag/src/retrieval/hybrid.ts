import type { EmbeddingProvider } from "../embeddings/provider";
import { cosineSimilarity, type VectorStore } from "../store/vectorStore";
import { queryTerms } from "../text/tokenize";
import type { Chunk, Language } from "../types";
import type { Bm25Index } from "./bm25";
import { reciprocalRankFusion } from "./rrf";

export type RetrievalMode = "hybrid" | "bm25" | "vector";

export interface SearchOptions {
  /** Results to return (default 8). */
  k?: number;
  /** Candidates taken from each leg before fusion (default max(30, 3k)). */
  candidates?: number;
  mode?: RetrievalMode;
  language?: Language;
  /** Only chunks whose file path starts with this prefix. */
  pathPrefix?: string;
  /** Fraction of query terms that must appear in the results (default 0.5). */
  minTermCoverage?: number;
  /** Minimum best cosine similarity (default: the embedding provider's suggestion). */
  minSimilarity?: number;
}

export interface SearchHit {
  chunk: Chunk;
  /** Fused RRF score (hybrid) or the single leg's score. */
  score: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  /** Cosine similarity between the query and this chunk's embedding. */
  similarity: number;
}

export interface RetrievalConfidence {
  lowConfidence: boolean;
  reason?: string;
  /** Best cosine similarity among returned hits (null in bm25-only mode). */
  topSimilarity: number | null;
  /** Share of distinct query terms found in at least one returned chunk. */
  termCoverage: number;
  queryTerms: string[];
  matchedTerms: string[];
}

export interface RetrievalResult {
  query: string;
  mode: RetrievalMode;
  hits: SearchHit[];
  confidence: RetrievalConfidence;
}

export interface RetrieverDeps {
  chunks: ReadonlyMap<string, Chunk>;
  chunkTerms: ReadonlyMap<string, ReadonlySet<string>>;
  bm25: Bm25Index;
  vectors: VectorStore;
  embedder: EmbeddingProvider;
  tokenize: (text: string) => string[];
}

/**
 * Hybrid retrieval: BM25 (exact identifiers, rare tokens) and vector search (fuzzy/semantic
 * matches) each nominate candidates, and Reciprocal Rank Fusion merges the two rankings.
 * The result carries a confidence assessment that callers use to refuse instead of guessing.
 */
export class HybridRetriever {
  constructor(private readonly deps: RetrieverDeps) {}

  async search(query: string, options: SearchOptions = {}): Promise<RetrievalResult> {
    const k = Math.max(1, options.k ?? 8);
    const candidates = options.candidates ?? Math.max(30, k * 3);
    const mode = options.mode ?? "hybrid";
    const filter = this.filterFor(options);

    const bm25Hits =
      mode === "vector" ? [] : this.deps.bm25.search(this.deps.tokenize(query), candidates, filter);
    const queryVector = mode === "bm25" ? undefined : await this.deps.embedder.embedQuery(query);
    const vectorHits = queryVector ? this.deps.vectors.search(queryVector, candidates, filter) : [];

    let ranked: { id: string; score: number; bm25Rank: number | null; vectorRank: number | null }[];
    if (mode === "hybrid") {
      ranked = reciprocalRankFusion([bm25Hits, vectorHits]).map((r) => ({
        id: r.id,
        score: r.score,
        bm25Rank: r.ranks[0] ?? null,
        vectorRank: r.ranks[1] ?? null,
      }));
    } else {
      const hits = mode === "bm25" ? bm25Hits : vectorHits;
      ranked = hits.map((h, i) => ({
        id: h.id,
        score: h.score,
        bm25Rank: mode === "bm25" ? i + 1 : null,
        vectorRank: mode === "vector" ? i + 1 : null,
      }));
    }

    const hits: SearchHit[] = [];
    for (const r of ranked.slice(0, k)) {
      const chunk = this.deps.chunks.get(r.id);
      if (!chunk) continue;
      const stored = queryVector ? this.deps.vectors.get(r.id) : undefined;
      hits.push({
        chunk,
        score: r.score,
        bm25Rank: r.bm25Rank,
        vectorRank: r.vectorRank,
        similarity: stored && queryVector ? cosineSimilarity(queryVector, stored) : 0,
      });
    }

    return { query, mode, hits, confidence: this.assess(query, hits, mode, options) };
  }

  private filterFor(options: SearchOptions): ((id: string) => boolean) | undefined {
    const { language, pathPrefix } = options;
    if (!language && !pathPrefix) return undefined;
    return (id) => {
      const chunk = this.deps.chunks.get(id);
      if (!chunk) return false;
      if (language && chunk.language !== language) return false;
      if (pathPrefix && !chunk.filePath.startsWith(pathPrefix)) return false;
      return true;
    };
  }

  private assess(
    query: string,
    hits: SearchHit[],
    mode: RetrievalMode,
    options: SearchOptions,
  ): RetrievalConfidence {
    const terms = queryTerms(query);
    const matched = terms.filter((t) =>
      hits.some((h) => this.deps.chunkTerms.get(h.chunk.id)?.has(t)),
    );
    const termCoverage = terms.length === 0 ? 0 : matched.length / terms.length;
    const topSimilarity = mode === "bm25" ? null : Math.max(0, ...hits.map((h) => h.similarity));
    const minCoverage = options.minTermCoverage ?? 0.5;
    const minSimilarity = options.minSimilarity ?? this.deps.embedder.minRelevantSimilarity;

    let reason: string | undefined;
    if (terms.length === 0) reason = "query has no searchable terms";
    else if (hits.length === 0) reason = "no matching code found";
    else if (termCoverage < minCoverage) {
      const missing = terms.filter((t) => !matched.includes(t));
      reason = `only ${matched.length}/${terms.length} query terms appear in the retrieved code (missing: ${missing.join(", ")})`;
    } else if (topSimilarity !== null && topSimilarity < minSimilarity) {
      reason = `best similarity ${topSimilarity.toFixed(3)} is below ${minSimilarity}`;
    }

    return {
      lowConfidence: reason !== undefined,
      ...(reason ? { reason } : {}),
      topSimilarity,
      termCoverage,
      queryTerms: terms,
      matchedTerms: matched,
    };
  }
}
