export interface FusedResult {
  id: string;
  /** Sum over lists of weight / (k + rank). */
  score: number;
  /** 1-based rank in each input list, or null when the id is absent from that list. */
  ranks: (number | null)[];
}

export interface RrfOptions {
  /** Smoothing constant from Cormack et al. (2009); 60 is the conventional default. */
  k?: number;
  /** Per-list weights (default 1 each). */
  weights?: number[];
}

/**
 * Reciprocal Rank Fusion. Only ranks are used, so lists with incomparable score scales
 * (BM25 vs cosine similarity) can be merged without normalization.
 */
export function reciprocalRankFusion(
  lists: ReadonlyArray<ReadonlyArray<{ id: string }>>,
  options: RrfOptions = {},
): FusedResult[] {
  const k = options.k ?? 60;
  const fused = new Map<string, FusedResult>();
  lists.forEach((list, listIndex) => {
    const weight = options.weights?.[listIndex] ?? 1;
    const seen = new Set<string>();
    let rank = 0;
    for (const { id } of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      let entry = fused.get(id);
      if (!entry) {
        entry = { id, score: 0, ranks: lists.map(() => null) };
        fused.set(id, entry);
      }
      entry.score += weight / (k + rank);
      entry.ranks[listIndex] = rank;
    }
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
