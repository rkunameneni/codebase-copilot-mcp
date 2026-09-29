import type Anthropic from "@anthropic-ai/sdk";
import { answerQuestion, formatSources, validateCitations } from "../src/answer/answer";
import { CodebaseIndex } from "../src/indexer";
import type { ClaudeConfig, MessageCreateParams, MessagesClient } from "../src/llm/client";
import type { LoadedPrompt } from "../src/llm/prompts";
import type { RetrievalResult } from "../src/retrieval/hybrid";
import { SAMPLE_REPO } from "./helpers";

const CONFIG: ClaudeConfig = { model: "claude-opus-5", effort: "medium", refusalFallback: true };
const PROMPT: LoadedPrompt = {
  id: "answer.system",
  version: 1,
  sha: "abc123abc123",
  body: "Answer from sources.",
  metadata: {},
};

function reply(
  text: string,
  stopReason: Anthropic.Beta.BetaStopReason = "end_turn",
): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: text ? [{ type: "text", text, citations: null }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Beta.BetaMessage;
}

function fakeClient(
  ...responses: Anthropic.Beta.BetaMessage[]
): MessagesClient & { requests: MessageCreateParams[] } {
  const requests: MessageCreateParams[] = [];
  return {
    requests,
    create: async (params) => {
      requests.push(params);
      const next = responses.shift();
      if (!next) throw new Error("no scripted response left");
      return next;
    },
  };
}

describe("answerQuestion", () => {
  let index: CodebaseIndex;
  let retrieval: RetrievalResult;
  let cancelChunk: { filePath: string; startLine: number; endLine: number };

  beforeAll(async () => {
    index = await CodebaseIndex.build(SAMPLE_REPO);
    retrieval = await index.search("what happens to stock and payment when an order is cancelled", {
      k: 6,
    });
    const hit = retrieval.hits.find(
      (h) => h.chunk.symbol === "cancelOrder" && h.chunk.container === "OrderService",
    );
    if (!hit) throw new Error("fixture: cancelOrder not retrieved");
    cancelChunk = hit.chunk;
  });

  it("answers with verified citations and sends a cached, fallback-enabled request", async () => {
    const cite = `[${cancelChunk.filePath}:${cancelChunk.startLine + 5}-${cancelChunk.startLine + 8}]`;
    const client = fakeClient(
      reply(`Cancelling releases each item's stock and refunds the payment ${cite}.`),
    );
    const answer = await answerQuestion("What happens when an order is cancelled?", retrieval, {
      client,
      config: CONFIG,
      prompt: PROMPT,
    });
    expect(answer.status).toBe("answered");
    expect(answer.citations).toHaveLength(1);
    expect(answer.invalidCitations).toEqual([]);
    expect(answer.usage.inputTokens).toBe(1200);
    expect(answer.costUsd).toBeGreaterThan(0);

    const request = client.requests[0]!;
    expect(request.model).toBe("claude-opus-5");
    expect(request.system).toEqual([
      { type: "text", text: PROMPT.body, cache_control: { type: "ephemeral" } },
    ]);
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");
    expect(request.output_config).toEqual({ effort: "medium" });
    const userContent = request.messages[0]!.content as string;
    expect(userContent).toContain(`path="${cancelChunk.filePath}"`);
    expect(userContent).toContain("<question>What happens when an order is cancelled?</question>");
  });

  it("refuses without calling the model when retrieval confidence is low", async () => {
    const lowConfidence = await index.search(
      "how does the kubernetes operator reconcile helm releases",
    );
    expect(lowConfidence.confidence.lowConfidence).toBe(true);
    const client = fakeClient();
    const answer = await answerQuestion("k8s?", lowConfidence, {
      client,
      config: CONFIG,
      prompt: PROMPT,
    });
    expect(answer.status).toBe("refused");
    expect(answer.refusalReason).toMatch(/Retrieval confidence too low/);
    expect(client.requests).toHaveLength(0);
    expect(answer.usage.calls).toBe(0);
  });

  it("surfaces the model's INSUFFICIENT_CONTEXT reply as a refusal", async () => {
    const client = fakeClient(
      reply("INSUFFICIENT_CONTEXT: the sources do not show the retry policy."),
    );
    const answer = await answerQuestion("What is the retry policy?", retrieval, {
      client,
      config: CONFIG,
      prompt: PROMPT,
    });
    expect(answer.status).toBe("refused");
    expect(answer.refusalReason).toContain("the sources do not show the retry policy");
  });

  it("flags an answer whose citations do not point into the sources as ungrounded", async () => {
    const client = fakeClient(
      reply("It calls the ledger service [src/Ledger.java:10-12] and logs [README.md:900]."),
    );
    const answer = await answerQuestion("q", retrieval, { client, config: CONFIG, prompt: PROMPT });
    expect(answer.status).toBe("ungrounded");
    expect(answer.invalidCitations).toEqual(["[src/Ledger.java:10-12]", "[README.md:900]"]);
  });

  it("treats a model refusal stop reason as a refusal", async () => {
    const client = fakeClient(reply("", "refusal"));
    const answer = await answerQuestion("q", retrieval, { client, config: CONFIG, prompt: PROMPT });
    expect(answer.status).toBe("refused");
    expect(answer.refusalReason).toMatch(/declined/);
  });
});

describe("citation helpers", () => {
  const hits = [
    {
      chunk: {
        id: "a",
        filePath: "src/A.java",
        startLine: 10,
        endLine: 20,
        language: "java",
        kind: "method",
        text: "x\ny",
      },
      score: 1,
      bm25Rank: 1,
      vectorRank: 1,
      similarity: 0.5,
    },
  ] as unknown as RetrievalResult["hits"];

  it("accepts citations inside a source range and rejects the rest", () => {
    const { valid, invalid } = validateCitations(
      "ok [src/A.java:10-12], single [src/A.java:20], outside [src/A.java:21], reversed [src/A.java:15-11], other [src/B.java:10]",
      hits,
    );
    expect(valid.map((c) => c.raw)).toEqual(["[src/A.java:10-12]", "[src/A.java:20]"]);
    expect(invalid).toEqual(["[src/A.java:21]", "[src/A.java:15-11]", "[src/B.java:10]"]);
  });

  it("renders sources with absolute line numbers", () => {
    const text = formatSources(hits);
    expect(text).toContain('<source id="1" path="src/A.java" lines="10-20">');
    expect(text).toContain("   10| x");
    expect(text).toContain("   11| y");
  });
});
