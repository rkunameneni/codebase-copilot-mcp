import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import {
  CodebaseIndex,
  type ClaudeConfig,
  type LoadedPrompt,
  type MessageCreateParams,
  type MessagesClient,
} from "@codebase-copilot/rag";
import { createContext, type ToolContext } from "@codebase-copilot/mcp-server";
import { MemoryLogger } from "../src/logger";
import {
  buildToolDefinitions,
  groundFindings,
  ReviewAgent,
  SUBMIT_TOOL,
  toInputSchema,
} from "../src/review/agent";
import { formatOutcome } from "../src/review/format";
import { ReviewSubmissionSchema } from "../src/review/schema";
import { targetFromPaths, type ReviewTarget } from "../src/review/targets";

const SAMPLE_REPO = path.resolve(__dirname, "../../../sample-repo");
const ORDER_SERVICE = "src/main/java/com/example/orders/service/OrderService.java";
const CONFIG: ClaudeConfig = { model: "claude-opus-5", effort: "high", refusalFallback: true };
const SYSTEM: LoadedPrompt = {
  id: "review.system",
  version: 1,
  sha: "000000000001",
  body: "You review code.",
  metadata: {},
};
const TASK: LoadedPrompt = {
  id: "review.task",
  version: 1,
  sha: "000000000002",
  body: "Review {{target}}.\n{{content}}",
  metadata: {},
};

type Block = Record<string, unknown>;
let blockId = 0;
const text = (t: string): Block => ({ type: "text", text: t, citations: null });
const toolUse = (name: string, input: unknown): Block => ({
  type: "tool_use",
  id: `toolu_${++blockId}`,
  name,
  input,
});
const thinking = (): Block => ({ type: "thinking", thinking: "", signature: "sig" });

function message(
  content: Block[],
  stopReason: string,
  usage: Partial<Anthropic.Beta.BetaUsage> = {},
): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${blockId}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 2000,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
  } as unknown as Anthropic.Beta.BetaMessage;
}

type Step = Anthropic.Beta.BetaMessage | Error;

/** Content blocks of a recorded request message, as plain objects. */
const blocks = (m: { content: unknown } | undefined): Block[] => (m?.content ?? []) as Block[];

/** A MessagesClient that replays a script and records every request (deep-copied). */
function scriptedClient(...steps: Step[]): MessagesClient & { requests: MessageCreateParams[] } {
  const requests: MessageCreateParams[] = [];
  return {
    requests,
    create: async (params) => {
      requests.push(JSON.parse(JSON.stringify(params)) as MessageCreateParams);
      const step = steps.shift();
      if (!step) throw new Error("script exhausted");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const validReview = (line = 69) => ({
  summary: "cancelOrder does not check the order status before refunding.",
  findings: [
    {
      severity: "high",
      file: ORDER_SERVICE,
      line,
      issue:
        "Cancelling an already SHIPPED or CANCELLED order refunds the payment again and releases stock twice.",
      suggestion:
        "Reject cancellation unless the status is PENDING or PAID, and make the refund idempotent.",
      category: "correctness",
    },
  ],
});

let tools: ToolContext;
let target: ReviewTarget;
beforeAll(async () => {
  const index = await CodebaseIndex.build(SAMPLE_REPO);
  tools = createContext(index);
  target = await targetFromPaths(index, [ORDER_SERVICE], { cwd: SAMPLE_REPO });
});

function agent(
  client: MessagesClient,
  extra: Partial<ConstructorParameters<typeof ReviewAgent>[0]> = {},
) {
  return new ReviewAgent({
    client,
    config: CONFIG,
    tools,
    systemPrompt: SYSTEM,
    taskPrompt: TASK,
    retry: { sleep: async () => {} },
    ...extra,
  });
}

describe("ReviewAgent tool loop", () => {
  it("gathers context with tools, then returns a validated, grounded review", async () => {
    const first = message(
      [
        thinking(),
        text("Let me look at the collaborators."),
        toolUse("explain_symbol", { symbol: "PaymentService.refundOrder" }),
        toolUse("find_references", { symbol: "cancelOrder" }),
      ],
      "tool_use",
    );
    const client = scriptedClient(
      first,
      message([toolUse(SUBMIT_TOOL, validReview())], "tool_use", { cache_read_input_tokens: 1500 }),
    );
    const logger = new MemoryLogger();
    const outcome = await agent(client, { logger }).review(target);

    expect(outcome.status).toBe("completed");
    expect(outcome.iterations).toBe(2);
    expect(outcome.toolCalls).toEqual([
      { name: "explain_symbol", ok: true },
      { name: "find_references", ok: true },
      { name: SUBMIT_TOOL, ok: true },
    ]);
    expect(outcome.report?.findings).toHaveLength(1);
    expect(outcome.report?.rejectedFindings).toEqual([]);
    expect(outcome.usage).toMatchObject({
      calls: 2,
      inputTokens: 4000,
      outputTokens: 600,
      cacheReadTokens: 1500,
    });
    expect(outcome.costUsd).toBeGreaterThan(0);
    expect(outcome.prompts).toEqual({
      system: "review.system@v1#000000000001",
      task: "review.task@v1#000000000002",
    });

    // Second request: history is append-only, thinking kept, and both tool results come back
    // together in one user message.
    const second = client.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]).toEqual(client.requests[0]!.messages[0]);
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: JSON.parse(JSON.stringify(first.content)),
    });
    expect(blocks(second.messages[1])[0]).toMatchObject({ type: "thinking" });
    const results = blocks(second.messages[2]);
    expect(results.map((r) => r.type)).toEqual(["tool_result", "tool_result"]);
    expect(String(results[0]!.content)).toContain("refundOrder");
    expect(results[0]!.is_error).toBeUndefined();

    expect(logger.events.map((e) => e.name)).toEqual(
      expect.arrayContaining(["llm_call", "tool_call", "review_finished"]),
    );
  });

  it("caches the system prompt, enables refusal fallback and sends every tool", async () => {
    const client = scriptedClient(message([toolUse(SUBMIT_TOOL, validReview())], "tool_use"));
    await agent(client).review(target);
    const request = client.requests[0]!;
    expect(request.system).toEqual([
      { type: "text", text: "You review code.", cache_control: { type: "ephemeral" } },
    ]);
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
    });
    expect(request.tools?.map((t) => (t as { name: string }).name)).toEqual([
      "search_code",
      "get_file_snippet",
      "explain_symbol",
      "find_references",
      "suggest_tests",
      SUBMIT_TOOL,
    ]);
    const firstUser = request.messages[0]!.content as string;
    expect(firstUser).toContain(`Review the file ${ORDER_SERVICE}.`);
    expect(firstUser).toContain("69|     public Order cancelOrder(Long orderId) {");
  });

  it("stops at the max-iteration guard", async () => {
    const loop = () => message([toolUse("search_code", { query: "order" })], "tool_use");
    const client = scriptedClient(loop(), loop(), loop(), loop());
    const outcome = await agent(client, { maxIterations: 3 }).review(target);
    expect(outcome.status).toBe("incomplete");
    expect(outcome.iterations).toBe(3);
    expect(outcome.message).toMatch(/max-iteration guard/);
    expect(client.requests).toHaveLength(3);
  });

  it("returns tool errors to the model as is_error results and continues", async () => {
    const client = scriptedClient(
      message([toolUse("get_file_snippet", { path: "../../secrets.env" })], "tool_use"),
      message([toolUse(SUBMIT_TOOL, validReview())], "tool_use"),
    );
    const outcome = await agent(client).review(target);
    expect(outcome.status).toBe("completed");
    const result = blocks(client.requests[1]!.messages[2])[0]!;
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toMatch(/escapes/);
  });

  it("asks the model to fix an invalid submission", async () => {
    const client = scriptedClient(
      message(
        [
          toolUse(SUBMIT_TOOL, {
            summary: "x",
            findings: [{ severity: "urgent", file: "a", line: 0 }],
          }),
        ],
        "tool_use",
      ),
      message([toolUse(SUBMIT_TOOL, validReview())], "tool_use"),
    );
    const outcome = await agent(client).review(target);
    expect(outcome.status).toBe("completed");
    const error = blocks(client.requests[1]!.messages[2])[0]!;
    expect(error.is_error).toBe(true);
    expect(String(error.content)).toMatch(/Invalid review: findings\.0\.severity/);
  });

  it("nudges once when the model answers in prose, then gives up", async () => {
    const client = scriptedClient(
      message([text("Looks fine to me.")], "end_turn"),
      message([text("Still fine.")], "end_turn"),
    );
    const outcome = await agent(client).review(target);
    expect(outcome.status).toBe("incomplete");
    expect(client.requests[1]!.messages[2]).toEqual({
      role: "user",
      content: expect.stringContaining(`calling ${SUBMIT_TOOL}`),
    });
  });

  it("reports refusals and truncated responses without running tools", async () => {
    const refused = await agent(scriptedClient(message([], "refusal"))).review(target);
    expect(refused.status).toBe("refused");
    const truncated = await agent(
      scriptedClient(message([toolUse("search_code", { query: "x" })], "max_tokens")),
    ).review(target);
    expect(truncated.status).toBe("incomplete");
    expect(truncated.toolCalls).toEqual([]);
    expect(truncated.message).toMatch(/max_tokens/);
  });

  it("continues after pause_turn without adding a user message", async () => {
    const client = scriptedClient(
      message([text("working")], "pause_turn"),
      message([toolUse(SUBMIT_TOOL, validReview())], "tool_use"),
    );
    const outcome = await agent(client).review(target);
    expect(outcome.status).toBe("completed");
    expect(client.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("retries 429 and 5xx responses with backoff", async () => {
    const headers = new Headers({ "retry-after": "0" });
    const sleeps: number[] = [];
    const client = scriptedClient(
      new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", headers),
      new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers()),
      message([toolUse(SUBMIT_TOOL, validReview())], "tool_use"),
    );
    const logger = new MemoryLogger();
    const outcome = await agent(client, {
      logger,
      retry: { baseDelayMs: 10, random: () => 0, sleep: async (ms) => void sleeps.push(ms) },
    }).review(target);
    expect(outcome.status).toBe("completed");
    expect(sleeps).toEqual([0, 10]);
    expect(logger.events.filter((e) => e.name === "llm_retry")).toHaveLength(2);
  });

  it("does not retry a 400", async () => {
    const client = scriptedClient(
      new Anthropic.BadRequestError(400, { type: "error" }, "bad", new Headers()),
    );
    await expect(agent(client).review(target)).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(client.requests).toHaveLength(1);
  });
});

describe("grounding and output", () => {
  it("discards findings that point at unknown files or lines past the end", () => {
    const review = ReviewSubmissionSchema.parse({
      summary: "s",
      findings: [
        { ...validReview().findings[0], line: 10_000 },
        { ...validReview().findings[0], file: "src/Imaginary.java" },
        { ...validReview().findings[0], file: `./${ORDER_SERVICE}`, severity: "low" },
        { ...validReview().findings[0], severity: "critical" },
      ],
    });
    const { accepted, rejected } = groundFindings(review.findings, target, tools);
    expect(accepted.map((f) => f.severity)).toEqual(["critical", "low"]);
    expect(accepted[1]?.file).toBe(ORDER_SERVICE);
    expect(rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/line 10000 does not exist/),
      expect.stringMatching(/not part of the review/),
    ]);
  });

  it("renders a readable report", async () => {
    const outcome = await agent(
      scriptedClient(message([toolUse(SUBMIT_TOOL, validReview())], "tool_use")),
    ).review(target);
    const rendered = formatOutcome(outcome);
    expect(rendered).toContain("Review completed - 1 model calls");
    expect(rendered).toContain(`[HIGH] ${ORDER_SERVICE}:69 (correctness)`);
    expect(rendered).toContain("Suggestion: Reject cancellation");
  });

  it("builds object JSON Schemas for every tool", () => {
    for (const tool of buildToolDefinitions()) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema).not.toHaveProperty("$schema");
    }
    const submit = toInputSchema(ReviewSubmissionSchema) as unknown as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(submit.required).toEqual(["summary", "findings"]);
    expect(submit.additionalProperties).toBe(false);
  });
});
