import Anthropic from "@anthropic-ai/sdk";

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type MessageCreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The one method this project needs from the SDK. Depending on this interface instead of the
 * concrete client keeps every Claude-calling component unit-testable with a scripted fake.
 */
export interface MessagesClient {
  create(params: MessageCreateParams): Promise<BetaMessage>;
}

export const DEFAULT_MODEL = "claude-opus-5";

/** Beta header for `fallbacks: "default"` (server-side refusal fallback). */
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ClaudeConfig {
  model: string;
  /** Omitted from the request when undefined (use for models without effort support). */
  effort?: Effort;
  /** Re-run a declined request on Anthropic's recommended fallback model, server-side. */
  refusalFallback: boolean;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function claudeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { effort?: Effort } = {},
): ClaudeConfig {
  const rawEffort = env.COPILOT_EFFORT?.trim();
  let effort: Effort | undefined = defaults.effort;
  if (rawEffort === "none" || rawEffort === "") effort = undefined;
  else if (rawEffort !== undefined) {
    if (!EFFORTS.includes(rawEffort as Effort)) {
      throw new Error(`COPILOT_EFFORT must be one of ${EFFORTS.join(", ")} or "none"`);
    }
    effort = rawEffort as Effort;
  }
  return {
    model: env.COPILOT_MODEL?.trim() || DEFAULT_MODEL,
    effort,
    refusalFallback: (env.COPILOT_REFUSAL_FALLBACK ?? "on").toLowerCase() !== "off",
  };
}

/** Request fields every call shares: model, effort and the refusal-fallback opt-in. */
export function baseRequest(
  config: ClaudeConfig,
): Pick<MessageCreateParams, "model" | "output_config" | "betas" | "fallbacks"> {
  const request: Pick<MessageCreateParams, "model" | "output_config" | "betas" | "fallbacks"> = {
    model: config.model,
  };
  if (config.effort) request.output_config = { effort: config.effort };
  if (config.refusalFallback) {
    request.betas = [REFUSAL_FALLBACK_BETA];
    request.fallbacks = "default";
  }
  return request;
}

/**
 * Real client. SDK-level retries are disabled (`maxRetries: 0`) because callers wrap requests in
 * {@link withRetry}, which owns backoff, jitter and retry-after handling in one visible place.
 */
export function createAnthropicMessagesClient(options: { apiKey?: string } = {}): MessagesClient {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  return {
    create: (params) => client.beta.messages.create(params),
  };
}

export function textOf(message: BetaMessage): string {
  return message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
