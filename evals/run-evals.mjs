#!/usr/bin/env node
// Offline retrieval eval: no API key, no network. Builds the index for the golden corpus with the
// local TF-IDF embeddings, runs every case through BM25-only, vector-only and hybrid retrieval,
// and reports recall@k, MRR and how the confidence gate handled unanswerable questions.
//
// Usage: npm run build && node evals/run-evals.mjs [--min-hybrid-recall5 <0..1>] [--json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import rag from "../packages/rag/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    "min-hybrid-recall5": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const golden = JSON.parse(readFileSync(path.join(here, "golden.json"), "utf8"));
const root = path.resolve(here, "..", golden.corpus);
const index = await rag.CodebaseIndex.build(root);
const report = await rag.runRetrievalEval(index, golden.cases, { ks: [1, 3, 5] });

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const lines = [
  `Corpus: ${golden.corpus} (${index.files.length} files, ${index.chunks.length} chunks, embeddings ${index.embedder.id})`,
  `Cases: ${report.answerable} answerable, ${report.unanswerable} unanswerable`,
  "",
  "| Mode | Recall@1 | Recall@3 | Recall@5 | MRR |",
  "| --- | --- | --- | --- | --- |",
  ...report.modes.map(
    (m) =>
      `| ${m.mode} | ${pct(m.meanRecall[1])} | ${pct(m.meanRecall[3])} | ${pct(m.meanRecall[5])} | ${m.mrr.toFixed(3)} |`,
  ),
  "",
  `Confidence gate (hybrid): ${report.refusal.correctRefusals}/${report.unanswerable} unanswerable questions refused, ` +
    `${report.refusal.falseRefusals}/${report.answerable} answerable questions wrongly refused.`,
  "",
  "Per-case hybrid results (first relevant rank):",
  ...report.modes
    .find((m) => m.mode === "hybrid")
    .cases.map(
      (c) => `  ${c.reciprocalRank > 0 ? `#${Math.round(1 / c.reciprocalRank)}` : "miss"}  ${c.id}`,
    ),
];

if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${lines.join("\n")}\n`);

const outDir = path.join(here, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, "latest.json"),
  `${JSON.stringify({ corpus: golden.corpus, embeddings: index.embedder.id, ...report }, null, 2)}\n`,
);

const gate = values["min-hybrid-recall5"];
if (gate !== undefined) {
  const hybrid = report.modes.find((m) => m.mode === "hybrid");
  if (hybrid.meanRecall[5] < Number(gate)) {
    console.error(
      `Hybrid recall@5 ${pct(hybrid.meanRecall[5])} is below the gate of ${pct(Number(gate))}`,
    );
    process.exit(1);
  }
}
