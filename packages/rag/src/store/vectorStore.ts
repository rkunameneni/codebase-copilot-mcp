import type { ScoredId } from "../retrieval/bm25";

export interface VectorRecord {
  id: string;
  vector: number[];
}

/** Minimal vector store contract; swap in pgvector, Qdrant, etc. behind the same interface. */
export interface VectorStore {
  readonly size: number;
  add(records: readonly VectorRecord[]): void;
  search(query: readonly number[], k: number, filter?: (id: string) => boolean): ScoredId[];
  get(id: string): number[] | undefined;
  records(): VectorRecord[];
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function norm(v: readonly number[]): number {
  return Math.sqrt(dot(v, v));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/** Exact (brute-force) cosine search. Fine up to tens of thousands of chunks. */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, { vector: number[]; norm: number }>();
  private dimensions: number | undefined;

  get size(): number {
    return this.entries.size;
  }

  add(records: readonly VectorRecord[]): void {
    for (const { id, vector } of records) {
      if (this.dimensions === undefined) this.dimensions = vector.length;
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Vector for ${id} has ${vector.length} dimensions; store expects ${this.dimensions}`,
        );
      }
      this.entries.set(id, { vector: [...vector], norm: norm(vector) });
    }
  }

  search(query: readonly number[], k: number, filter?: (id: string) => boolean): ScoredId[] {
    if (k <= 0 || this.entries.size === 0) return [];
    const queryNorm = norm(query);
    if (queryNorm === 0) return [];
    const results: ScoredId[] = [];
    for (const [id, entry] of this.entries) {
      if (filter && !filter(id)) continue;
      const score = entry.norm === 0 ? 0 : dot(query, entry.vector) / (queryNorm * entry.norm);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return results.slice(0, k);
  }

  get(id: string): number[] | undefined {
    return this.entries.get(id)?.vector;
  }

  records(): VectorRecord[] {
    return [...this.entries].map(([id, e]) => ({ id, vector: e.vector }));
  }
}
