import { chunkByWindow, chunkFile, chunkStructured, windowRanges } from "../src/chunking/chunker";
import { maskCode, matchBraces } from "../src/chunking/lexer";
import { sourceFile } from "./helpers";

const JAVA = `package com.acme.billing;

import java.util.List;

/** Issues invoices. */
@Service
public class InvoiceService {

    private final InvoiceRepository repository;
    private static final String TEMPLATE = "Invoice {id} for {customer}";

    public InvoiceService(InvoiceRepository repository) {
        this.repository = repository;
    }

    /**
     * Creates an invoice.
     * @throws IllegalArgumentException when amount is negative
     */
    @Transactional
    public Invoice create(String customer, long amountCents) {
        if (amountCents < 0) {
            throw new IllegalArgumentException("amount must not be negative: }");
        }
        // a closing brace in a comment: }
        return repository.save(new Invoice(customer, amountCents));
    }

    private int legacyFee(
            int amount,
            boolean waived) {
        char open = '{';
        return waived ? 0 : amount / 100;
    }

    interface Hook {
        void onCreate(Invoice invoice);
    }
}
`;

describe("maskCode", () => {
  it("blanks strings, chars and comments but keeps line structure", () => {
    const source = "a = \"{\"; // }\nb = '}'; /* {\n } */ c = `${x}`;";
    const masked = maskCode(source);
    expect(masked.split("\n")).toHaveLength(3);
    expect(masked.length).toBe(source.length);
    expect(masked).not.toMatch(/[{}]/);
    expect(masked).toContain("a =");
    expect(masked).toContain("c =");
  });

  it("handles Java text blocks", () => {
    const masked = maskCode('String s = """\n  { not code }\n  """;\nint x = 1;');
    expect(masked).not.toMatch(/[{}]/);
    expect(masked).toContain("int x = 1;");
  });

  it("recovers from an unterminated string at the end of a line", () => {
    const masked = maskCode('String s = "oops\nclass A {}');
    expect(masked.split("\n")[1]).toBe("class A {}");
  });
});

describe("matchBraces", () => {
  it("pairs nested braces and closes unbalanced ones at EOF", () => {
    const pairs = matchBraces(["a {", "  b { }", "}", "c {"]);
    expect(pairs.get("0:2")?.closeLine).toBe(2);
    expect(pairs.get("1:4")?.closeLine).toBe(1);
    expect(pairs.get("3:2")?.closeLine).toBe(3);
  });
});

describe("chunkStructured (Java)", () => {
  const chunks = chunkStructured(sourceFile("src/InvoiceService.java", JAVA, "java"));
  const bySymbol = (name: string) => chunks.find((c) => c.symbol === name);

  it("emits one chunk per method and constructor with container and signature", () => {
    expect(bySymbol("InvoiceService")?.kind).toBe("class");
    expect(chunks.find((c) => c.kind === "constructor")?.symbol).toBe("InvoiceService");
    const create = bySymbol("create");
    expect(create).toMatchObject({ kind: "method", container: "InvoiceService" });
    expect(create?.signature).toBe("public Invoice create(String customer, long amountCents)");
  });

  it("includes Javadoc and annotations with the method", () => {
    const create = bySymbol("create");
    expect(create?.text.startsWith("    /**")).toBe(true);
    expect(create?.text).toContain("@Transactional");
    expect(create?.startLine).toBe(16);
    expect(create?.endLine).toBe(27);
  });

  it("is not fooled by braces inside strings, chars and comments", () => {
    const create = bySymbol("create");
    expect(create?.text.trimEnd().endsWith("}")).toBe(true);
    expect(create?.text).toContain("return repository.save");
    const legacy = bySymbol("legacyFee");
    expect(legacy?.signature).toBe("private int legacyFee( int amount, boolean waived)");
    expect(legacy?.text).toContain("return waived");
  });

  it("chunks nested types without swallowing them into methods", () => {
    const hook = bySymbol("Hook");
    expect(hook).toMatchObject({ kind: "class", container: "InvoiceService" });
    expect(hook?.text).toContain("void onCreate");
  });

  it("keeps imports and fields in block chunks and records 1-based line ranges", () => {
    const preamble = chunks[0];
    expect(preamble).toMatchObject({ kind: "block", startLine: 1, endLine: 3 });
    expect(preamble?.id).toBe("src/InvoiceService.java:1-3");
    const header = bySymbol("InvoiceService");
    expect(header?.text).toContain("private final InvoiceRepository repository;");
  });

  it("covers every non-trivial line of the file", () => {
    const lines = JAVA.split("\n");
    lines.forEach((line, i) => {
      if (/^[\s{}();,]*$/.test(line)) return;
      const covered = chunks.some((c) => c.startLine <= i + 1 && c.endLine >= i + 1);
      expect({ line: i + 1, covered }).toEqual({ line: i + 1, covered: true });
    });
  });
});

describe("chunkStructured (TypeScript)", () => {
  const TS = `import { z } from "zod";

export interface Options {
  retries: number;
}

export class Client {
  constructor(private readonly base: string) {}

  async get(path: string, opts: Options = { retries: 1 }): Promise<string> {
    const url = \`\${this.base}/\${path}\`;
    return url;
  }
}

export function parse(input: string): number {
  return Number(input);
}

export const double = (n: number): number => {
  return n * 2;
};
`;
  const chunks = chunkStructured(sourceFile("src/client.ts", TS, "typescript"));

  it("finds classes, methods, functions and arrow functions", () => {
    const summary = chunks.map((c) => `${c.kind}:${c.container ?? ""}.${c.symbol ?? ""}`);
    expect(summary).toEqual(
      expect.arrayContaining([
        "class:.Options",
        "class:.Client",
        "constructor:Client.constructor",
        "method:Client.get",
        "function:.parse",
        "function:.double",
      ]),
    );
  });

  it("skips braces inside default parameter values when finding the body", () => {
    const get = chunks.find((c) => c.symbol === "get");
    expect(get?.startLine).toBe(10);
    expect(get?.endLine).toBe(13);
  });
});

describe("oversized chunks and fallbacks", () => {
  it("splits a long method into overlapping windows that keep the symbol", () => {
    const body = Array.from({ length: 120 }, (_, i) => `        int v${i} = ${i};`).join("\n");
    const java = `class Big {\n    void huge() {\n${body}\n    }\n}\n`;
    const chunks = chunkStructured(sourceFile("Big.java", java, "java"), {
      maxChunkLines: 50,
      windowLines: 40,
      windowOverlap: 10,
    });
    const parts = chunks.filter((c) => c.symbol === "huge");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.startLine).toBe(2);
    expect(parts[1]?.startLine).toBe(32);
    expect(parts[parts.length - 1]?.endLine).toBe(123);
  });

  it("uses sliding windows for unstructured languages", () => {
    const md = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile(sourceFile("docs/guide.md", md, "markdown"));
    expect(chunks.every((c) => c.kind === "window")).toBe(true);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 40],
      [33, 72],
      [65, 100],
    ]);
  });

  it("skips whitespace-only windows and empty files", () => {
    expect(chunkByWindow(sourceFile("a.txt", "\n\n\n", "text"))).toEqual([]);
    expect(chunkFile(sourceFile("a.java", "   \n", "java"))).toEqual([]);
  });

  it("computes window ranges that end exactly at the last line", () => {
    expect(windowRanges(0, 9, 4, 1)).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
    expect(windowRanges(0, 2, 10, 2)).toEqual([[0, 2]]);
  });
});
