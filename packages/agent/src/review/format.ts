import type { ReviewOutcome } from "./agent";

/** Human-readable rendering of a review outcome for the terminal. */
export function formatOutcome(outcome: ReviewOutcome): string {
  const lines: string[] = [];
  const cost = outcome.costUsd === undefined ? "n/a" : `$${outcome.costUsd.toFixed(4)}`;
  lines.push(
    `Review ${outcome.status} - ${outcome.iterations} model calls, ${outcome.toolCalls.length} tool calls, ` +
      `${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out tokens ` +
      `(cache read ${outcome.usage.cacheReadTokens}, cache write ${outcome.usage.cacheWriteTokens}), est. ${cost}`,
  );
  if (outcome.message) lines.push(outcome.message);
  const report = outcome.report;
  if (!report) return lines.join("\n");
  lines.push("", report.summary, "");
  if (report.findings.length === 0) lines.push("No findings.");
  for (const f of report.findings) {
    lines.push(
      `[${f.severity.toUpperCase()}] ${f.file}:${f.line}${f.category ? ` (${f.category})` : ""}`,
    );
    lines.push(`  Issue:      ${f.issue}`);
    lines.push(`  Suggestion: ${f.suggestion}`);
    lines.push("");
  }
  if (report.rejectedFindings.length > 0) {
    lines.push(
      `${report.rejectedFindings.length} finding(s) discarded because their location could not be verified:`,
    );
    for (const r of report.rejectedFindings)
      lines.push(`  - ${r.finding.file}:${r.finding.line}: ${r.reason}`);
  }
  return lines.join("\n").trimEnd();
}
