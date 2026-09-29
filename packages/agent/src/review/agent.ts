import type Anthropic from "@anthropic-ai/sdk";
import {
  baseRequest,
  loadPrompt,
  renderPrompt,
  UsageTracker,
  withRetry,
  type BetaMessageParam,
  type ClaudeConfig,
  type LoadedPrompt,
  type MessageCreateParams,
  type MessagesClient,
  type RetryOptions,
  type UsageTotals,
} from "@codebase-copilot/rag";
import { callTool, TOOLS, type ToolContext } from "@codebase-copilot/mcp-server";
import { z } from "zod";
import { silentLogger, type Logger } from "../logger";
import {
  ReviewSubmissionSchema,
  sortFindings,
  type Finding,
  type RejectedFinding,
  type ReviewReport,
} from "./schema";
import type { ReviewTarget } from "./targets";

export const SUBMIT_TOOL = "submit_review";

export type ReviewStatus = "completed" | "incomplete" | "refused";

export interface ReviewOutcome {
  status: ReviewStatus;
  report?: ReviewReport;
  /** Why the run did not complete, when it did not. */
  message?: string;
  iterations: number;
  toolCalls: { name: string; ok: boolean }[];
  usage: UsageTotals;
  costUsd?: number;
  model: string;
  prompts: { system: string; task: string };
}

export interface ReviewAgentOptions {
  client: MessagesClient;
  config: ClaudeConfig;
  tools: ToolContext;
  /** Hard cap on model calls per review (default 8). */
  maxIterations?: number;
  /** Per-response output cap (default 16000). */
  maxTokens?: number;
  retry?: RetryOptions;
  logger?: Logger;
  systemPrompt?: LoadedPrompt;
  taskPrompt?: LoadedPrompt;
}

type BetaTool = Anthropic.Beta.BetaTool;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** Converts a zod object schema to the JSON Schema shape the Messages API expects. */
export function toInputSchema(schema: z.ZodType): BetaTool["input_schema"] {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: "object" } as BetaTool["input_schema"];
}

/** The model-facing tool list: the five codebase tools plus the structured-output tool. */
export function buildToolDefinitions(): BetaTool[] {
  const codebaseTools: BetaTool[] = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toInputSchema(tool.inputSchema),
  }));
  const submit: BetaTool = {
    name: SUBMIT_TOOL,
    description:
      "Submit the finished review. Call exactly once, after gathering context, with every finding. An empty findings list is valid when nothing meets the reporting bar.",
    input_schema: toInputSchema(ReviewSubmissionSchema),
  };
  return [...codebaseTools, submit];
}

/**
 * Checks each finding against the files it names: the file must be under review (or at least
 * indexed) and the line must exist. This is the guard against plausible-looking findings that
 * point at nothing.
 */
export function groundFindings(
  findings: readonly Finding[],
  target: ReviewTarget,
  tools: ToolContext,
): { accepted: Finding[]; rejected: RejectedFinding[] } {
  const accepted: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  for (const finding of findings) {
    const file = finding.file.replace(/\\/g, "/").replace(/^\.\//, "");
    const lines =
      target.files.find((f) => f.path === file)?.lines ?? tools.index.getFile(file)?.lines;
    if (lines === undefined) {
      rejected.push({ finding, reason: `${file} is not part of the review or the index` });
    } else if (finding.line > lines) {
      rejected.push({
        finding,
        reason: `${file} has ${lines} lines; line ${finding.line} does not exist`,
      });
    } else {
      accepted.push({ ...finding, file });
    }
  }
  return { accepted: sortFindings(accepted), rejected };
}

/**
 * AI-assisted code review as a manual Claude tool-use loop.
 *
 * - The system prompt (and the tool definitions rendered before it) carry an explicit cache
 *   breakpoint; top-level automatic caching covers the growing conversation.
 * - The assistant's content is appended verbatim every turn (thinking blocks included), which
 *   keeps the history append-only so caching and thinking stay valid.
 * - All tool calls from one turn run in parallel and return in a single user message.
 * - The run ends when `submit_review` passes schema validation, and is bounded by
 *   `maxIterations`; 429/5xx responses are retried with exponential backoff.
 */
export class ReviewAgent {
  private readonly maxIterations: number;
  private readonly maxTokens: number;
  private readonly logger: Logger;
  private readonly systemPrompt: LoadedPrompt;
  private readonly taskPrompt: LoadedPrompt;
  private readonly toolDefinitions: BetaTool[];

  constructor(private readonly options: ReviewAgentOptions) {
    this.maxIterations = options.maxIterations ?? 8;
    this.maxTokens = options.maxTokens ?? 16000;
    this.logger = options.logger ?? silentLogger;
    this.systemPrompt = options.systemPrompt ?? loadPrompt("review.system");
    this.taskPrompt = options.taskPrompt ?? loadPrompt("review.task");
    this.toolDefinitions = buildToolDefinitions();
  }

  /** The first request exactly as it would be sent; used by `--dry-run`. */
  initialRequest(target: ReviewTarget): MessageCreateParams {
    return this.request([{ role: "user", content: this.taskMessage(target) }]);
  }

  private taskMessage(target: ReviewTarget): string {
    return renderPrompt(this.taskPrompt.body, {
      target: target.description,
      content: target.content,
    });
  }

  private request(messages: BetaMessageParam[]): MessageCreateParams {
    return {
      ...baseRequest(this.options.config),
      max_tokens: this.maxTokens,
      system: [
        { type: "text", text: this.systemPrompt.body, cache_control: { type: "ephemeral" } },
      ],
      cache_control: { type: "ephemeral" },
      tools: this.toolDefinitions,
      messages,
    };
  }

  async review(target: ReviewTarget): Promise<ReviewOutcome> {
    const { client, config, tools } = this.options;
    const usage = new UsageTracker(config.model);
    const toolCalls: ReviewOutcome["toolCalls"] = [];
    const messages: BetaMessageParam[] = [{ role: "user", content: this.taskMessage(target) }];
    let nudged = false;

    const finish = (status: ReviewStatus, extra: Partial<ReviewOutcome> = {}): ReviewOutcome => {
      const outcome: ReviewOutcome = {
        status,
        iterations: usage.totals.calls,
        toolCalls,
        usage: usage.totals,
        costUsd: usage.costUsd(),
        model: config.model,
        prompts: {
          system: `${this.systemPrompt.id}@v${this.systemPrompt.version}#${this.systemPrompt.sha}`,
          task: `${this.taskPrompt.id}@v${this.taskPrompt.version}#${this.taskPrompt.sha}`,
        },
        ...extra,
      };
      this.logger.event("review_finished", {
        status,
        iterations: outcome.iterations,
        toolCalls: toolCalls.length,
        ...usage.totals,
        costUsd: outcome.costUsd ?? null,
        findings: outcome.report?.findings.length ?? null,
        rejectedFindings: outcome.report?.rejectedFindings.length ?? null,
      });
      return outcome;
    };

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      const started = Date.now();
      const response = await withRetry(() => client.create(this.request(messages)), {
        ...this.options.retry,
        onRetry: (info) => {
          this.logger.event("llm_retry", {
            iteration,
            attempt: info.attempt,
            delayMs: info.delayMs,
            error: info.error instanceof Error ? info.error.message : String(info.error),
          });
          this.options.retry?.onRetry?.(info);
        },
      });
      const call = usage.record(response.usage);
      this.logger.event("llm_call", {
        iteration,
        model: response.model,
        stopReason: response.stop_reason,
        latencyMs: Date.now() - started,
        ...call,
        cumulativeCostUsd: usage.costUsd() ?? null,
      });

      if (response.stop_reason === "refusal") {
        return finish("refused", { message: "The model declined to review this content." });
      }
      if (
        response.stop_reason === "max_tokens" ||
        response.stop_reason === "model_context_window_exceeded"
      ) {
        return finish("incomplete", {
          message: `The response was cut off (${response.stop_reason}); review a smaller target.`,
        });
      }

      // Append-only history: the assistant turn goes back exactly as received.
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (nudged) {
          return finish("incomplete", {
            message: "The model ended without calling submit_review.",
          });
        }
        nudged = true;
        messages.push({
          role: "user",
          content: `Submit your review now by calling ${SUBMIT_TOOL} with a summary and the findings list.`,
        });
        continue;
      }

      let report: ReviewReport | undefined;
      const results = await Promise.all(
        toolUses.map(async (use): Promise<ToolResultBlockParam> => {
          if (use.name === SUBMIT_TOOL) {
            const parsed = ReviewSubmissionSchema.safeParse(use.input);
            if (!parsed.success) {
              const issues = parsed.error.issues
                .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
                .join("; ");
              return {
                type: "tool_result",
                tool_use_id: use.id,
                is_error: true,
                content: `Invalid review: ${issues}`,
              };
            }
            const { accepted, rejected } = groundFindings(parsed.data.findings, target, tools);
            report = {
              summary: parsed.data.summary,
              findings: accepted,
              rejectedFindings: rejected,
            };
            return { type: "tool_result", tool_use_id: use.id, content: "Review received." };
          }
          const result = await callTool(tools, use.name, use.input);
          this.logger.event("tool_call", {
            iteration,
            tool: use.name,
            ok: result.ok,
            chars: result.text.length,
          });
          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: result.text,
            ...(result.ok ? {} : { is_error: true }),
          };
        }),
      );

      // Record calls in the order the model issued them, not the order they finished.
      toolUses.forEach((use, i) => toolCalls.push({ name: use.name, ok: !results[i]?.is_error }));
      if (report) return finish("completed", { report });
      messages.push({ role: "user", content: results });
    }

    return finish("incomplete", {
      message: `Stopped after ${this.maxIterations} model calls without a submitted review (max-iteration guard).`,
    });
  }
}
