/**
 * Code-aware tokenizer shared by BM25, the local TF-IDF embedder and confidence scoring.
 *
 * Identifiers are kept whole (lower-cased) *and* split on camelCase / snake_case boundaries,
 * so a query for "order not found" matches `OrderNotFoundException` and a query for
 * "OrderService" matches the identifier exactly.
 */

const ENGLISH_STOPWORDS = [
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "there",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
];

/** Keywords that appear in nearly every chunk and carry no retrieval signal. */
const CODE_STOPWORDS = [
  "public",
  "private",
  "protected",
  "static",
  "final",
  "void",
  "return",
  "new",
  "import",
  "package",
  "this",
  "const",
  "let",
  "var",
  "export",
  "async",
  "await",
];

export const STOPWORDS: ReadonlySet<string> = new Set([...ENGLISH_STOPWORDS, ...CODE_STOPWORDS]);

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*|\d+/g;

/** Splits `parseHTTPResponse_v2` into `["parse", "http", "response", "v2"]`. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/** Light, predictable normalization: plural -> singular only. */
export function normalizeTerm(term: string): string {
  if (term.length > 3 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(xes|sses|shes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss") && !term.endsWith("us")) {
    return term.slice(0, -1);
  }
  return term;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    const raw = match[0];
    const whole = raw.toLowerCase();
    const parts = splitIdentifier(raw);
    if (parts.length > 1 && whole.length >= 2 && !STOPWORDS.has(whole)) {
      tokens.push(whole);
    }
    for (const part of parts) {
      if (part.length < 2 || STOPWORDS.has(part)) continue;
      tokens.push(normalizeTerm(part));
    }
  }
  return tokens;
}

/** Unique query terms, in first-seen order. */
export function queryTerms(text: string): string[] {
  return [...new Set(tokenize(text))];
}
