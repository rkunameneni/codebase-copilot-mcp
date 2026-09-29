import { baseRequest, textOf, type ClaudeConfig, type MessagesClient } from "../llm/client";
import { loadPrompt, type LoadedPrompt } from "../llm/prompts";
import { withRetry, type RetryOptions } from "../llm/retry";
import { UsageTracker, type UsageTotals } from "../llm/usage";
import type { RetrievalResult, SearchHit } from "../retrieval/hybrid";

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  /** The citation text exactly as the model wrote it. */
  raw: string;
}

export type AnswerStatus = "answered" | "refused" | "ungrounded";

export interface GroundedAnswer {
  status: AnswerStatus;
  answer: string;
  citations: Citation[];
  /** Citations that do not point inside a retrieved source; they are reported, never trusted. */
  invalidCitations: string[];
  refusalReason?: string;
  prompt: { id: string; version: number; sha: string };
  usage: UsageTotals;
  costUsd?: number;
}

export interface AnswerDeps {
  client: MessagesClient;
  config: ClaudeConfig;
  prompt?: LoadedPrompt;
  retry?: RetryOptions;
  maxTokens?: number;
}

export const INSUFFICIENT_CONTEXT = "INSUFFICIENT_CONTEXT";

const CITATION_RE = /\[([^\]\s:]+):(\d+)(?:-(\d+))?\]/g;

/** Formats retrieved chunks as numbered, attributed sources for the prompt. */
export function formatSources(hits: readonly SearchHit[]): string {
  return hits
    .map((hit, n) => {
      const c = hit.chunk;
      const symbol = c.symbol ? ` symbol="${c.container ? `${c.container}.` : ""}${c.symbol}"` : "";
      const numbered = c.text
        .split("\n")
        .map((line, i) => `${String(c.startLine + i).padStart(5)}| ${line}`)
        .join("\n");
      return `<source id="${n + 1}" path="${c.filePath}" lines="${c.startLine}-${c.endLine}"${symbol}>\n${numbered}\n</source>`;
    })
    .join("\n\n");
}

/**
 * Extracts `[path:start-end]` citations and checks each against the retrieved sources: the file
 * must be one of the sources and the cited range must fall inside that source's line range.
 */
export function validateCitations(
  answer: string,
  hits: readonly SearchHit[],
): { valid: Citation[]; invalid: string[] } {
  const valid: Citation[] = [];
  const invalid: string[] = [];
  for (const match of answer.matchAll(CITATION_RE)) {
    const raw = match[0];
    const filePath = match[1] as string;
    const startLine = Number(match[2]);
    const endLine = match[3] ? Number(match[3]) : startLine;
    const supported = hits.some(
      (h) =>
        h.chunk.filePath === filePath &&
        startLine <= endLine &&
        startLine >= h.chunk.startLine &&
        endLine <= h.chunk.endLine,
    );
    if (supported) valid.push({ filePath, startLine, endLine, raw });
    else invalid.push(raw);
  }
  return { valid, invalid };
}

/**
 * Citation-grounded question answering over retrieved code.
 *
 * 1. Low-confidence retrieval is refused before any tokens are spent.
 * 2. Claude answers only from the numbered sources and must cite `[path:start-end]`.
 * 3. The model can decline with INSUFFICIENT_CONTEXT; that is surfaced as a refusal.
 * 4. Citations are verified against the sources; an answer with none that verify is flagged
 *    "ungrounded" instead of being presented as fact.
 */
export async function answerQuestion(
  question: string,
  retrieval: RetrievalResult,
  deps: AnswerDeps,
): Promise<GroundedAnswer> {
  const prompt = deps.prompt ?? loadPrompt("answer.system");
  const promptRef = { id: prompt.id, version: prompt.version, sha: prompt.sha };
  const usage = new UsageTracker(deps.config.model);

  const refuse = (reason: string, answer = ""): GroundedAnswer => ({
    status: "refused",
    answer,
    citations: [],
    invalidCitations: [],
    refusalReason: reason,
    prompt: promptRef,
    usage: usage.totals,
    costUsd: usage.costUsd(),
  });

  if (retrieval.confidence.lowConfidence) {
    return refuse(`Retrieval confidence too low: ${retrieval.confidence.reason ?? "unknown"}`);
  }

  const response = await withRetry(
    () =>
      deps.client.create({
        ...baseRequest(deps.config),
        max_tokens: deps.maxTokens ?? 4096,
        system: [{ type: "text", text: prompt.body, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: `<sources>\n${formatSources(retrieval.hits)}\n</sources>\n\n<question>${question}</question>`,
          },
        ],
      }),
    deps.retry,
  );
  usage.record(response.usage);

  if (response.stop_reason === "refusal") {
    return refuse("The model declined to answer this request.");
  }
  const answer = textOf(response).trim();
  if (answer.startsWith(INSUFFICIENT_CONTEXT)) {
    const reason = answer.slice(INSUFFICIENT_CONTEXT.length).replace(/^[:\s]+/, "");
    return refuse(`The retrieved code does not answer the question. ${reason}`.trim(), answer);
  }

  const { valid, invalid } = validateCitations(answer, retrieval.hits);
  return {
    status: valid.length > 0 ? "answered" : "ungrounded",
    answer,
    citations: valid,
    invalidCitations: invalid,
    prompt: promptRef,
    usage: usage.totals,
    costUsd: usage.costUsd(),
  };
}
