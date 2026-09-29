import Anthropic from "@anthropic-ai/sdk";

/** HTTP failure from a non-Anthropic endpoint (e.g. Voyage), shaped so retry logic can inspect it. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export interface RetryOptions {
  /** Retries after the first attempt (default 4). */
  maxRetries?: number;
  /** First backoff delay (default 1000 ms); doubles each attempt. */
  baseDelayMs?: number;
  /** Upper bound for any single delay, including server-provided retry-after (default 30 s). */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns [0, 1). */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function statusOf(error: unknown): number | undefined {
  if (error instanceof Anthropic.APIError) return error.status;
  if (error instanceof HttpStatusError) return error.status;
  return undefined;
}

/**
 * Retry only what can succeed on a second attempt: rate limits (429), server errors (5xx,
 * including 529 overloaded) and connection failures/timeouts. 4xx client errors are
 * permanent and are rethrown immediately.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  const status = statusOf(error);
  return status !== undefined && (status === 429 || status >= 500);
}

/** Parses a retry-after header value (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function retryAfterOf(error: unknown): string | null | undefined {
  if (error instanceof Anthropic.APIError) return error.headers?.get("retry-after");
  if (error instanceof HttpStatusError) return error.retryAfter;
  return undefined;
}

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** attempt);
  return Math.round(exponential / 2 + (random() * exponential) / 2);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 4;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const serverHint = parseRetryAfter(retryAfterOf(error));
      const delayMs = Math.min(maxDelay, serverHint ?? backoffDelay(attempt, options));
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}
