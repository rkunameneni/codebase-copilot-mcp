import type { EmbeddingProvider } from "./provider";
import { TfidfEmbeddingProvider } from "./tfidf";
import { VoyageEmbeddingProvider } from "./voyage";

/**
 * Chooses the embedding backend from the environment:
 * `COPILOT_EMBEDDINGS=voyage` (+ `VOYAGE_API_KEY`, optional `VOYAGE_MODEL`) or the default
 * local TF-IDF provider, which needs no key and no network.
 */
export function embeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const choice = (env.COPILOT_EMBEDDINGS ?? "tfidf").toLowerCase();
  if (choice === "tfidf") return new TfidfEmbeddingProvider();
  if (choice === "voyage") {
    const apiKey = env.VOYAGE_API_KEY;
    if (!apiKey) throw new Error("COPILOT_EMBEDDINGS=voyage requires VOYAGE_API_KEY");
    return new VoyageEmbeddingProvider({ apiKey, model: env.VOYAGE_MODEL || undefined });
  }
  throw new Error(`Unknown COPILOT_EMBEDDINGS value "${choice}" (expected tfidf or voyage)`);
}
