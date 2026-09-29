import type { CodebaseIndex } from "../indexer";
import type { RetrievalMode } from "../retrieval/hybrid";

/** A labelled query: which files (optionally which symbol) a good retriever must surface. */
export interface GoldenCase {
  id: string;
  query: string;
  /** Relevant targets as `path` or `path#symbol`. */
  relevant: string[];
  /** True for questions the corpus cannot answer; used to score refusals. */
  expectRefusal?: boolean;
}

export interface CaseResult {
  id: string;
  query: string;
  /** Distinct targets in rank order (file-level, or `file#symbol` when the case asks for symbols). */
  ranked: string[];
  recall: Record<number, number>;
  reciprocalRank: number;
  refused: boolean;
}

export interface ModeReport {
  mode: RetrievalMode;
  meanRecall: Record<number, number>;
  mrr: number;
  cases: CaseResult[];
}

export interface EvalReport {
  ks: number[];
  answerable: number;
  unanswerable: number;
  modes: ModeReport[];
  /** Refusal behaviour of the confidence gate in hybrid mode. */
  refusal: {
    correctRefusals: number;
    falseRefusals: number;
    missedRefusals: number;
  };
}

/** recall@k: share of relevant targets present in the first k ranked targets. */
export function recallAtK(
  ranked: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

/** 1 / rank of the first relevant target, or 0 if none is ranked. */
export function reciprocalRank(ranked: readonly string[], relevant: readonly string[]): number {
  const idx = ranked.findIndex((r) => relevant.includes(r));
  return idx < 0 ? 0 : 1 / (idx + 1);
}

function rankTargets(
  hits: { chunk: { filePath: string; symbol?: string } }[],
  bySymbol: boolean,
): string[] {
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const { chunk } of hits) {
    const target = bySymbol && chunk.symbol ? `${chunk.filePath}#${chunk.symbol}` : chunk.filePath;
    if (!seen.has(target)) {
      seen.add(target);
      ranked.push(target);
    }
  }
  return ranked;
}

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Runs every golden case against every retrieval mode. Fully offline and deterministic. */
export async function runRetrievalEval(
  index: CodebaseIndex,
  cases: readonly GoldenCase[],
  options: { ks?: number[]; modes?: RetrievalMode[]; retrieveK?: number } = {},
): Promise<EvalReport> {
  const ks = options.ks ?? [1, 3, 5];
  const modes = options.modes ?? ["bm25", "vector", "hybrid"];
  const retrieveK = options.retrieveK ?? 20;
  const answerable = cases.filter((c) => !c.expectRefusal);
  const refusal = { correctRefusals: 0, falseRefusals: 0, missedRefusals: 0 };

  const reports: ModeReport[] = [];
  for (const mode of modes) {
    const results: CaseResult[] = [];
    for (const c of cases) {
      const retrieval = await index.search(c.query, { k: retrieveK, mode });
      const bySymbol = c.relevant.some((r) => r.includes("#"));
      const ranked = rankTargets(retrieval.hits, bySymbol);
      const refused = retrieval.confidence.lowConfidence;
      if (mode === "hybrid") {
        if (c.expectRefusal && refused) refusal.correctRefusals += 1;
        if (c.expectRefusal && !refused) refusal.missedRefusals += 1;
        if (!c.expectRefusal && refused) refusal.falseRefusals += 1;
      }
      if (c.expectRefusal) continue;
      results.push({
        id: c.id,
        query: c.query,
        ranked: ranked.slice(0, Math.max(...ks)),
        recall: Object.fromEntries(ks.map((k) => [k, recallAtK(ranked, c.relevant, k)])),
        reciprocalRank: reciprocalRank(ranked, c.relevant),
        refused,
      });
    }
    reports.push({
      mode,
      meanRecall: Object.fromEntries(
        ks.map((k) => [k, mean(results.map((r) => r.recall[k] ?? 0))]),
      ),
      mrr: mean(results.map((r) => r.reciprocalRank)),
      cases: results,
    });
  }

  return {
    ks,
    answerable: answerable.length,
    unanswerable: cases.length - answerable.length,
    modes: reports,
    refusal,
  };
}
