import { tokenize } from "../text/tokenize";
import type { EmbeddingProvider } from "./provider";

export interface TfidfOptions {
  /** Hashed feature space size (default 1024). */
  dimensions?: number;
  /** Weight of character trigram features relative to word features (default 0.5). */
  trigramWeight?: number;
}

interface TfidfState {
  dimensions: number;
  trigramWeight: number;
  documentCount: number;
  documentFrequency: number[];
}

/** 32-bit FNV-1a; deterministic across platforms and Node versions. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic local embeddings that need no API key or network: TF-IDF over hashed features
 * (the "hashing trick"), L2-normalized.
 *
 * Features are code-aware word tokens plus character trigrams of each token. The trigrams give
 * the vector leg a different failure profile from BM25: `cancellation` still overlaps with
 * `cancel`, and `refunds` with `refundOrder`. It is still a lexical model; a neural embedding
 * provider (see {@link VoyageEmbeddingProvider}) is what adds real semantic recall.
 */
export class TfidfEmbeddingProvider implements EmbeddingProvider {
  readonly minRelevantSimilarity = 0.1;
  private state: TfidfState;

  constructor(options: TfidfOptions = {}) {
    const dimensions = options.dimensions ?? 1024;
    this.state = {
      dimensions,
      trigramWeight: options.trigramWeight ?? 0.5,
      documentCount: 0,
      documentFrequency: new Array<number>(dimensions).fill(0),
    };
  }

  get id(): string {
    return `tfidf-hash-v1:${this.state.dimensions}`;
  }

  /** Weighted feature counts, keyed by bucket; the sign bit reduces collision bias. */
  private features(text: string): Map<number, number> {
    const { dimensions, trigramWeight } = this.state;
    const counts = new Map<number, number>();
    const addFeature = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const bucket = h % dimensions;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      counts.set(bucket, (counts.get(bucket) ?? 0) + sign * weight);
    };
    for (const token of tokenize(text)) {
      addFeature(`w:${token}`, 1);
      if (trigramWeight > 0 && token.length > 3) {
        const padded = `^${token}$`;
        for (let i = 0; i + 3 <= padded.length; i++) {
          addFeature(`c:${padded.slice(i, i + 3)}`, trigramWeight);
        }
      }
    }
    return counts;
  }

  fit(documents: readonly string[]): void {
    const df = new Array<number>(this.state.dimensions).fill(0);
    for (const doc of documents) {
      for (const bucket of this.features(doc).keys()) df[bucket] = (df[bucket] as number) + 1;
    }
    this.state = { ...this.state, documentCount: documents.length, documentFrequency: df };
  }

  private vectorize(text: string): number[] {
    const { dimensions, documentCount, documentFrequency } = this.state;
    const vector = new Array<number>(dimensions).fill(0);
    for (const [bucket, raw] of this.features(text)) {
      const magnitude = Math.abs(raw);
      if (magnitude === 0) continue;
      const tf = 1 + Math.log(magnitude);
      const df = documentFrequency[bucket] ?? 0;
      const idf = Math.log((1 + documentCount) / (1 + df)) + 1;
      vector[bucket] = Math.sign(raw) * tf * idf;
    }
    let sumSquares = 0;
    for (const v of vector) sumSquares += v * v;
    const length = Math.sqrt(sumSquares);
    return length === 0 ? vector : vector.map((v) => v / length);
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vectorize(text);
  }

  exportState(): TfidfState {
    return this.state;
  }

  importState(state: unknown): void {
    const s = state as Partial<TfidfState> | null;
    if (
      !s ||
      typeof s.dimensions !== "number" ||
      typeof s.documentCount !== "number" ||
      !Array.isArray(s.documentFrequency) ||
      s.documentFrequency.length !== s.dimensions
    ) {
      throw new Error("Invalid TF-IDF embedding state in index file");
    }
    this.state = {
      dimensions: s.dimensions,
      trigramWeight: typeof s.trigramWeight === "number" ? s.trigramWeight : 0.5,
      documentCount: s.documentCount,
      documentFrequency: s.documentFrequency.map(Number),
    };
  }
}
