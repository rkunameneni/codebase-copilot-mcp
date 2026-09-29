/**
 * Pluggable embedding backend. Documents and queries are embedded separately because some
 * models (e.g. Voyage) use different input types for each.
 */
export interface EmbeddingProvider {
  /** Stable identifier persisted in the index; a mismatch on load forces a rebuild. */
  readonly id: string;
  /**
   * Suggested minimum cosine similarity for the top hit before an answer is attempted.
   * This is a starting point, not a calibrated value; tune it on your own corpus.
   */
  readonly minRelevantSimilarity: number;
  /** Called once with the full corpus before embedDocuments (for providers that learn statistics). */
  fit?(documents: readonly string[]): void;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /** JSON-serializable state needed to embed new queries after the index is reloaded. */
  exportState?(): unknown;
  importState?(state: unknown): void;
}
