/** USD per million tokens. Source: Anthropic public pricing as of 2026-09; verify before relying on it. */
export interface ModelPricing {
  input: number;
  output: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Prompt-cache multipliers relative to the base input price (5-minute TTL writes). */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function estimateCostUsd(model: string, usage: UsageTotals): number | undefined {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return undefined;
  const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(pricing.input) +
    usage.cacheWriteTokens * perToken(pricing.input) * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * perToken(pricing.input) * CACHE_READ_MULTIPLIER +
    usage.outputTokens * perToken(pricing.output)
  );
}

/**
 * Accumulates token usage across the calls of one task (an answer, a review) so cost is
 * reported per completed task rather than per request.
 *
 * The estimate uses the requested model's list price. If a server-side refusal fallback served
 * a turn, that turn was billed at the fallback model's rate, so treat the figure as approximate.
 */
export class UsageTracker {
  readonly totals: UsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };

  constructor(readonly model: string) {}

  record(usage: UsageLike): UsageTotals {
    const call: UsageTotals = {
      calls: 1,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    };
    this.totals.calls += 1;
    this.totals.inputTokens += call.inputTokens;
    this.totals.outputTokens += call.outputTokens;
    this.totals.cacheWriteTokens += call.cacheWriteTokens;
    this.totals.cacheReadTokens += call.cacheReadTokens;
    return call;
  }

  costUsd(): number | undefined {
    return estimateCostUsd(this.model, this.totals);
  }
}
