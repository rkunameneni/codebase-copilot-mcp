/**
 * A deliberately small lexer for C-family languages (Java, TypeScript, JavaScript).
 *
 * It does not build an AST. It produces a "masked" copy of the source in which comments and
 * string/char/template literals are replaced by spaces (newlines are preserved), so that brace
 * matching and declaration regexes never trip over `"{"` inside a string or `}` inside a comment.
 */

type State = "code" | "line-comment" | "block-comment" | "string" | "text-block" | "template";

export function maskCode(source: string): string {
  const out: string[] = new Array<string>(source.length);
  let state: State = "code";
  let quote = "";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (ch === "\n") {
      out[i] = "\n";
      if (state === "line-comment") state = "code";
      // An unterminated ordinary string cannot span lines; recover instead of masking the file.
      if (state === "string") state = "code";
      continue;
    }

    switch (state) {
      case "code":
        if (ch === "/" && next === "/") {
          state = "line-comment";
          out[i] = " ";
        } else if (ch === "/" && next === "*") {
          state = "block-comment";
          out[i] = " ";
        } else if (ch === '"' && next === '"' && source[i + 2] === '"') {
          state = "text-block";
          out[i] = " ";
          out[i + 1] = " ";
          out[i + 2] = " ";
          i += 2;
        } else if (ch === '"' || ch === "'") {
          state = "string";
          quote = ch;
          out[i] = " ";
        } else if (ch === "`") {
          state = "template";
          out[i] = " ";
        } else {
          out[i] = ch;
        }
        break;
      case "line-comment":
        out[i] = " ";
        break;
      case "block-comment":
        out[i] = " ";
        if (ch === "*" && next === "/") {
          out[i + 1] = " ";
          i += 1;
          state = "code";
        }
        break;
      case "string":
        out[i] = " ";
        if (ch === "\\") {
          if (next !== undefined && next !== "\n") out[i + 1] = " ";
          if (next !== "\n") i += 1;
        } else if (ch === quote) {
          state = "code";
        }
        break;
      case "text-block":
        out[i] = " ";
        if (ch === "\\" && next !== undefined && next !== "\n") {
          out[i + 1] = " ";
          i += 1;
        } else if (ch === '"' && next === '"' && source[i + 2] === '"') {
          out[i + 1] = " ";
          out[i + 2] = " ";
          i += 2;
          state = "code";
        }
        break;
      case "template":
        out[i] = " ";
        if (ch === "\\" && next !== undefined && next !== "\n") {
          out[i + 1] = " ";
          i += 1;
        } else if (ch === "`") {
          state = "code";
        }
        break;
    }
  }
  return out.join("");
}

export interface BracePair {
  /** 0-based line of the opening brace. */
  openLine: number;
  openColumn: number;
  /** 0-based line of the matching closing brace, or the last line if unbalanced. */
  closeLine: number;
}

/**
 * Matches braces in masked source. Returns a lookup keyed by `${line}:${column}` of each `{`.
 * Unbalanced opening braces are closed at the end of the file so a syntax error never loses code.
 */
export function matchBraces(maskedLines: string[]): Map<string, BracePair> {
  const pairs = new Map<string, BracePair>();
  const stack: { line: number; column: number }[] = [];
  maskedLines.forEach((line, lineIndex) => {
    for (let column = 0; column < line.length; column++) {
      const ch = line[column];
      if (ch === "{") {
        stack.push({ line: lineIndex, column });
      } else if (ch === "}") {
        const open = stack.pop();
        if (open) {
          pairs.set(`${open.line}:${open.column}`, {
            openLine: open.line,
            openColumn: open.column,
            closeLine: lineIndex,
          });
        }
      }
    }
  });
  const lastLine = Math.max(0, maskedLines.length - 1);
  for (const open of stack) {
    pairs.set(`${open.line}:${open.column}`, {
      openLine: open.line,
      openColumn: open.column,
      closeLine: lastLine,
    });
  }
  return pairs;
}

/** Brace depth at the start of every line (0 = top level). */
export function depthAtLineStart(maskedLines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of maskedLines) {
    depths.push(depth);
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return depths;
}
