import { HttpStatusError, withRetry, type RetryOptions } from "../llm/retry";
import type { EmbeddingProvider } from "./provider";

export interface VoyageOptions {
  apiKey: string;
  /** Default `voyage-code-3`, Voyage's code retrieval model. */
  model?: string;
  /** Inputs per request (default 64). */
  batchSize?: number;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
}

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

/**
 * Adapter for the Voyage AI embeddings REST API. Anthropic does not offer an embeddings
 * endpoint and its docs point to Voyage AI, so this is the optional neural backend.
 * Enabled with `COPILOT_EMBEDDINGS=voyage` and `VOYAGE_API_KEY`.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly minRelevantSimilarity = 0.25;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryOptions;

  constructor(options: VoyageOptions) {
    if (!options.apiKey) throw new Error("VoyageEmbeddingProvider requires an API key");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "voyage-code-3";
    this.batchSize = options.batchSize ?? 64;
    this.baseUrl = options.baseUrl ?? "https://api.voyageai.com/v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retry = options.retry ?? {};
  }

  get id(): string {
    return `voyage:${this.model}`;
  }

  private async request(
    input: readonly string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input, model: this.model, input_type: inputType }),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        throw new HttpStatusError(
          response.status,
          `Voyage embeddings request failed with HTTP ${response.status}`,
          retryAfter,
        );
      }
      const body = (await response.json()) as VoyageResponse;
      if (!Array.isArray(body.data) || body.data.length !== input.length) {
        throw new Error("Voyage embeddings response did not contain one vector per input");
      }
      return [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }, this.retry);
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      vectors.push(...(await this.request(texts.slice(i, i + this.batchSize), "document")));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.request([text], "query");
    if (!vector) throw new Error("Voyage returned no embedding for the query");
    return vector;
  }
}
