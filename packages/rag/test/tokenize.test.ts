import { normalizeTerm, queryTerms, splitIdentifier, tokenize } from "../src/text/tokenize";

describe("splitIdentifier", () => {
  it.each([
    ["placeOrder", ["place", "order"]],
    ["OrderNotFoundException", ["order", "not", "found", "exception"]],
    ["parseHTTPResponse_v2", ["parse", "http", "response", "v2"]],
    ["MAX_ITEMS", ["max", "items"]],
    ["x", ["x"]],
  ])("splits %s", (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });
});

describe("normalizeTerm", () => {
  it("singularizes regular plurals and leaves other words alone", () => {
    expect(normalizeTerm("orders")).toBe("order");
    expect(normalizeTerm("policies")).toBe("policy");
    expect(normalizeTerm("taxes")).toBe("tax");
    expect(normalizeTerm("classes")).toBe("class");
    expect(normalizeTerm("hashes")).toBe("hash");
    expect(normalizeTerm("class")).toBe("class");
    expect(normalizeTerm("status")).toBe("status");
    expect(normalizeTerm("is")).toBe("is");
  });
});

describe("tokenize", () => {
  it("keeps compound identifiers whole and also emits their parts", () => {
    const tokens = tokenize("orderRepository.findById(id)");
    expect(tokens).toEqual(
      expect.arrayContaining(["orderrepository", "order", "repository", "findbyid", "find", "id"]),
    );
  });

  it("drops English and code stopwords", () => {
    const tokens = tokenize("How does the public static void method return a value?");
    for (const stopword of ["how", "the", "public", "static", "void", "return"]) {
      expect(tokens).not.toContain(stopword);
    }
    expect(tokens).toEqual(expect.arrayContaining(["method", "value"]));
  });

  it("matches a natural-language query against an exception class name", () => {
    const code = new Set(tokenize("throw new OrderNotFoundException(orderId);"));
    for (const term of queryTerms("order not found")) expect(code.has(term)).toBe(true);
  });

  it("returns unique query terms in first-seen order", () => {
    expect(queryTerms("cancel order cancel orders")).toEqual(["cancel", "order"]);
  });
});
