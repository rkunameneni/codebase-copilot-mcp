import Anthropic from "@anthropic-ai/sdk";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  baseRequest,
  claudeConfigFromEnv,
  DEFAULT_MODEL,
  REFUSAL_FALLBACK_BETA,
} from "../src/llm/client";
import { loadPrompt, parsePromptFile, renderPrompt, resolvePromptsDir } from "../src/llm/prompts";
import {
  backoffDelay,
  HttpStatusError,
  isRetryable,
  parseRetryAfter,
  withRetry,
} from "../src/llm/retry";
import { estimateCostUsd, UsageTracker } from "../src/llm/usage";

const headers = (h: Record<string, string> = {}) => new Headers(h);
const rateLimited = (retryAfter?: string) =>
  new Anthropic.RateLimitError(
    429,
    { type: "error" },
    "rate limited",
    headers(retryAfter ? { "retry-after": retryAfter } : {}),
  );
const serverError = (status = 500) =>
  new Anthropic.InternalServerError(status, { type: "error" }, "server error", headers());
const badRequest = () =>
  new Anthropic.BadRequestError(400, { type: "error" }, "bad request", headers());

describe("isRetryable", () => {
  it("retries 429, 5xx, 529 and connection errors but not 4xx", () => {
    expect(isRetryable(rateLimited())).toBe(true);
    expect(isRetryable(serverError(500))).toBe(true);
    expect(isRetryable(serverError(529))).toBe(true);
    expect(isRetryable(new Anthropic.APIConnectionError({ message: "socket hang up" }))).toBe(true);
    expect(isRetryable(new HttpStatusError(503, "unavailable"))).toBe(true);
    expect(isRetryable(badRequest())).toBe(false);
    expect(isRetryable(new HttpStatusError(404, "missing"))).toBe(false);
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("doubles per attempt with equal jitter and respects the cap", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(0, { ...opts, random: () => 0 })).toBe(50);
    expect(backoffDelay(0, { ...opts, random: () => 0.999999 })).toBe(100);
    expect(backoffDelay(3, { ...opts, random: () => 0 })).toBe(400);
    expect(backoffDelay(10, { ...opts, random: () => 1 })).toBe(1000);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("withRetry", () => {
  it("retries retryable failures with exponential backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(serverError(503))
      .mockResolvedValue("ok");
    const retries: number[] = [];
    const result = await withRetry(fn, {
      baseDelayMs: 100,
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
      onRetry: ({ attempt }) => retries.push(attempt),
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([75, 150]);
    expect(retries).toEqual([1, 2]);
  });

  it("prefers the server's retry-after hint, capped by maxDelayMs", async () => {
    const sleeps: number[] = [];
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(rateLimited("120"))
      .mockResolvedValue("ok");
    await withRetry(fn, { maxDelayMs: 5000, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([5000]);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const error = serverError(500);
    const fn = jest.fn<Promise<string>, []>().mockRejectedValue(error);
    await expect(withRetry(fn, { maxRetries: 2, sleep: async () => {} })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = jest.fn<Promise<string>, []>().mockRejectedValue(badRequest());
    await expect(withRetry(fn, { sleep: async () => {} })).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("usage and cost", () => {
  it("accumulates usage across calls and prices cache reads/writes", () => {
    const tracker = new UsageTracker("claude-opus-5");
    tracker.record({
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 4000,
      cache_read_input_tokens: 0,
    });
    tracker.record({
      input_tokens: 500,
      output_tokens: 100,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 4000,
    });
    expect(tracker.totals).toEqual({
      calls: 2,
      inputTokens: 1500,
      outputTokens: 300,
      cacheWriteTokens: 4000,
      cacheReadTokens: 4000,
    });
    // 1500*5 + 4000*5*1.25 + 4000*5*0.1 + 300*25 = 7500 + 25000 + 2000 + 7500 = 42000 per million
    expect(tracker.costUsd()).toBeCloseTo(0.042, 10);
  });

  it("returns undefined for models without a price entry", () => {
    expect(
      estimateCostUsd("some-future-model", {
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeUndefined();
  });
});

describe("claude config", () => {
  it("defaults to the latest Opus with refusal fallback on", () => {
    const config = claudeConfigFromEnv({}, { effort: "high" });
    expect(config).toEqual({ model: DEFAULT_MODEL, effort: "high", refusalFallback: true });
    expect(baseRequest(config)).toEqual({
      model: "claude-opus-5",
      output_config: { effort: "high" },
      betas: [REFUSAL_FALLBACK_BETA],
      fallbacks: "default",
    });
  });

  it("honours overrides and validates effort", () => {
    const config = claudeConfigFromEnv({
      COPILOT_MODEL: "claude-sonnet-5",
      COPILOT_EFFORT: "none",
      COPILOT_REFUSAL_FALLBACK: "off",
    });
    expect(baseRequest(config)).toEqual({ model: "claude-sonnet-5" });
    expect(() => claudeConfigFromEnv({ COPILOT_EFFORT: "extreme" })).toThrow(/COPILOT_EFFORT/);
  });
});

describe("prompts", () => {
  it("finds the repository prompts directory and loads the latest version", () => {
    const dir = resolvePromptsDir({});
    const prompt = loadPrompt("answer.system", { dir });
    expect(prompt.version).toBeGreaterThanOrEqual(1);
    expect(prompt.body).toContain("INSUFFICIENT_CONTEXT");
    expect(prompt.body).not.toContain("---");
    expect(prompt.sha).toMatch(/^[0-9a-f]{12}$/);
  });

  it("picks the highest version unless one is pinned", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prompts-"));
    writeFileSync(path.join(dir, "demo.v1.md"), "---\nid: demo\nversion: 1\n---\nfirst");
    writeFileSync(path.join(dir, "demo.v2.md"), "second");
    expect(loadPrompt("demo", { dir }).body).toBe("second");
    expect(loadPrompt("demo", { dir, version: 1 })).toMatchObject({
      version: 1,
      body: "first",
      metadata: { id: "demo" },
    });
    expect(() => loadPrompt("demo", { dir, version: 3 })).toThrow(/not found/);
    expect(() => loadPrompt("missing", { dir })).toThrow(/not found/);
  });

  it("parses front matter and renders variables strictly", () => {
    expect(parsePromptFile("---\na: 1\nb: two words\n---\nbody")).toEqual({
      metadata: { a: "1", b: "two words" },
      body: "body",
    });
    expect(renderPrompt("Review {{target}}.", { target: "Foo.java" })).toBe("Review Foo.java.");
    expect(() => renderPrompt("{{missing}}", {})).toThrow(/missing/);
  });
});
