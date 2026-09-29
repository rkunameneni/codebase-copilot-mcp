export interface Bm25Params {
  /** Term-frequency saturation (default 1.2). */
  k1: number;
  /** Length normalization (default 0.75). */
  b: number;
}

export interface ScoredId {
  id: string;
  score: number;
}

interface Posting {
  doc: number;
  tf: number;
}

/**
 * Okapi BM25 over pre-tokenized documents.
 *
 * idf uses the non-negative variant `ln(1 + (N - df + 0.5) / (df + 0.5))`, so very common terms
 * contribute little but never subtract from a score.
 */
export class Bm25Index {
  private readonly params: Bm25Params;
  private readonly ids: string[] = [];
  private readonly docLengths: number[] = [];
  private readonly postings = new Map<string, Posting[]>();
  private totalLength = 0;

  constructor(params: Partial<Bm25Params> = {}) {
    this.params = { k1: params.k1 ?? 1.2, b: params.b ?? 0.75 };
  }

  get size(): number {
    return this.ids.length;
  }

  add(id: string, tokens: readonly string[]): void {
    const doc = this.ids.length;
    this.ids.push(id);
    this.docLengths.push(tokens.length);
    this.totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
      }
      list.push({ doc, tf });
    }
  }

  documentFrequency(term: string): number {
    return this.postings.get(term)?.length ?? 0;
  }

  idf(term: string): number {
    const n = this.ids.length;
    const df = this.documentFrequency(term);
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Scores every document containing at least one query term and returns the top `k`.
   * Duplicate query terms are counted once. Ties are broken by id for determinism.
   */
  search(queryTokens: readonly string[], k: number, filter?: (id: string) => boolean): ScoredId[] {
    if (this.ids.length === 0 || k <= 0) return [];
    const { k1, b } = this.params;
    const avgdl = this.totalLength / this.ids.length || 1;
    const scores = new Map<number, number>();
    for (const term of new Set(queryTokens)) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = this.idf(term);
      for (const { doc, tf } of list) {
        const dl = this.docLengths[doc] as number;
        const norm = tf + k1 * (1 - b + (b * dl) / avgdl);
        scores.set(doc, (scores.get(doc) ?? 0) + idf * ((tf * (k1 + 1)) / norm));
      }
    }
    const results: ScoredId[] = [];
    for (const [doc, score] of scores) {
      const id = this.ids[doc] as string;
      if (filter && !filter(id)) continue;
      results.push({ id, score });
    }
    results.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
    return results.slice(0, k);
  }
}
