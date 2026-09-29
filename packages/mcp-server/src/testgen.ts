import path from "node:path";
import type { Chunk, CodebaseIndex } from "@codebase-copilot/rag";
import { ToolInputError } from "./security";
import { extractDoc } from "./symbols";

export type TestFramework = "junit" | "jest";

export interface Param {
  name: string;
  type: string;
}

export interface ParsedMethod {
  name: string;
  returnType: string;
  params: Param[];
  isStatic: boolean;
  isAsync: boolean;
}

export interface TestSuggestion {
  framework: TestFramework;
  testFilePath: string;
  className?: string;
  method: ParsedMethod;
  /** Scenarios derived from the code: exceptions thrown, boolean branches, null guards. */
  scenarios: string[];
  /** Collaborators the method calls, which a real test must stub or verify. */
  collaboratorCalls: string[];
  code: string;
}

/** Splits on commas that are not nested inside <>, (), [] or {}. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("<([{".includes(ch)) depth += 1;
    else if (">)]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function paramsSection(signature: string): { before: string; inside: string; after: string } {
  const open = signature.indexOf("(");
  if (open < 0) throw new ToolInputError(`Cannot parse a parameter list from: ${signature}`);
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === "(") depth += 1;
    else if (signature[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          before: signature.slice(0, open),
          inside: signature.slice(open + 1, i),
          after: signature.slice(i + 1),
        };
      }
    }
  }
  return { before: signature.slice(0, open), inside: signature.slice(open + 1), after: "" };
}

const JAVA_MODIFIERS =
  /\b(public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\b/g;

export function parseJavaSignature(signature: string): ParsedMethod {
  const withoutAnnotations = signature.replace(/@\w+(\([^)]*\))?/g, " ");
  const { before, inside } = paramsSection(withoutAnnotations);
  const isStatic = /\bstatic\b/.test(before);
  const head = before
    .replace(JAVA_MODIFIERS, " ")
    .replace(/^\s*<[^>]*>/, " ")
    .trim();
  const nameMatch = /([A-Za-z_$][\w$]*)\s*$/.exec(head);
  if (!nameMatch) throw new ToolInputError(`Cannot find a method name in: ${signature}`);
  const name = nameMatch[1] as string;
  const returnType = head.slice(0, nameMatch.index).trim() || "void";
  const params = splitTopLevel(inside).map((raw) => {
    const cleaned = raw.replace(/\bfinal\b/g, " ").trim();
    const m = /^(.*?)\s*([A-Za-z_$][\w$]*)$/.exec(cleaned);
    return { type: (m?.[1] ?? "Object").trim(), name: m?.[2] ?? "arg" };
  });
  return { name, returnType, params, isStatic, isAsync: false };
}

export function parseTsSignature(signature: string): ParsedMethod {
  const { before, inside, after: afterParams } = paramsSection(signature);
  const isAsync = /\basync\b/.test(before);
  const isStatic = /\bstatic\b/.test(before);
  const cleanedHead = before
    .replace(
      /\b(export|default|async|function|public|private|protected|static|readonly|override|const|let|var)\b/g,
      " ",
    )
    .replace(/[=:].*$/, "")
    .trim();
  const nameMatch = /([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*$/.exec(cleanedHead);
  const name = nameMatch?.[1] ?? "subject";
  const returnMatch = /^\s*:\s*([^={]+)/.exec(afterParams);
  const params = splitTopLevel(inside).map((raw) => {
    const cleaned = raw.replace(/\b(public|private|protected|readonly)\b/g, " ").trim();
    const [left, ...rest] = cleaned.split(":");
    const paramName = (left ?? "arg").replace(/[?=].*$/, "").trim();
    const type = rest.join(":").replace(/=.*$/, "").trim() || "unknown";
    return { name: paramName, type };
  });
  return { name, returnType: returnMatch?.[1]?.trim() ?? "unknown", params, isStatic, isAsync };
}

/** Exceptions a method can throw: `throw new X`, `orElseThrow(() -> new X)`, `@throws X`. */
export function thrownExceptions(chunk: Chunk): string[] {
  const found = new Set<string>();
  for (const m of chunk.text.matchAll(/throw\s+new\s+([A-Z][\w$]*)/g)) found.add(m[1] as string);
  for (const m of chunk.text.matchAll(/orElseThrow\(\s*\(\)\s*->\s*new\s+([A-Z][\w$]*)/g)) {
    found.add(m[1] as string);
  }
  for (const m of (extractDoc(chunk) ?? "").matchAll(/@throws\s+([A-Z][\w$]*)/g))
    found.add(m[1] as string);
  return [...found];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

const JDK_IMPORTS: Record<string, string> = {
  BigDecimal: "java.math.BigDecimal",
  List: "java.util.List",
  Set: "java.util.Set",
  Map: "java.util.Map",
  Optional: "java.util.Optional",
  Instant: "java.time.Instant",
  Duration: "java.time.Duration",
  LocalDate: "java.time.LocalDate",
};

export function javaSampleValue(type: string, name: string): string {
  const base = type.replace(/<.*>/, "").trim();
  switch (base) {
    case "int":
    case "Integer":
    case "short":
    case "Short":
    case "byte":
    case "Byte":
      return "1";
    case "long":
    case "Long":
      return "1L";
    case "double":
    case "Double":
      return "1.0";
    case "float":
    case "Float":
      return "1.0f";
    case "boolean":
    case "Boolean":
      return "true";
    case "char":
    case "Character":
      return "'a'";
    case "String":
      return `"${name}"`;
    case "BigDecimal":
      return 'new BigDecimal("10.00")';
    case "List":
      return "List.of()";
    case "Set":
      return "Set.of()";
    case "Map":
      return "Map.of()";
    case "Optional":
      return "Optional.empty()";
    default:
      return `mock(${base}.class)`;
  }
}

function packageOf(index: CodebaseIndex, filePath: string): string | undefined {
  for (const chunk of index.chunksForFile(filePath)) {
    const m = /^\s*package\s+([\w.]+)\s*;/m.exec(chunk.text);
    if (m) return m[1];
  }
  return undefined;
}

function javaImportFor(
  index: CodebaseIndex,
  simpleType: string,
  ownPackage?: string,
): string | undefined {
  if (JDK_IMPORTS[simpleType]) return JDK_IMPORTS[simpleType];
  const definition = index.chunks.find(
    (c) => c.kind === "class" && c.symbol === simpleType && !c.container,
  );
  if (!definition) return undefined;
  const pkg = packageOf(index, definition.filePath);
  return pkg && pkg !== ownPackage ? `${pkg}.${simpleType}` : undefined;
}

function simpleTypes(type: string): string[] {
  return [...type.matchAll(/[A-Z][\w$]*/g)].map((m) => m[0]);
}

interface Field {
  type: string;
  name: string;
}

/** Fields assigned by the constructor (no initializer), i.e. injected collaborators. */
function injectedFields(index: CodebaseIndex, chunk: Chunk): Field[] {
  if (!chunk.container) return [];
  const classChunks = index
    .chunksForFile(chunk.filePath)
    .filter(
      (c) =>
        c.container === chunk.container || (c.kind === "class" && c.symbol === chunk.container),
    );
  const fields: Field[] = [];
  for (const c of classChunks) {
    if (c.kind !== "class" && c.kind !== "block") continue;
    for (const m of c.text.matchAll(
      /^\s*(?:private|protected)\s+(?:final\s+)?([\w$.<>, ?]+?)\s+([a-zA-Z_$][\w$]*)\s*;/gm,
    )) {
      fields.push({ type: (m[1] as string).trim(), name: m[2] as string });
    }
  }
  return fields;
}

function collaboratorCalls(chunk: Chunk, fields: readonly Field[]): string[] {
  const calls = new Set<string>();
  for (const field of fields) {
    const re = new RegExp(`\\b${field.name}\\.([a-zA-Z_$][\\w$]*)\\(`, "g");
    for (const m of chunk.text.matchAll(re)) calls.add(`${field.name}.${m[1]}`);
  }
  return [...calls];
}

function generateJUnit(index: CodebaseIndex, chunk: Chunk): TestSuggestion {
  if (!chunk.signature) throw new ToolInputError(`${chunk.id} has no parsable signature`);
  const method = parseJavaSignature(chunk.signature);
  const className = chunk.container ?? path.basename(chunk.filePath, ".java");
  const pkg = packageOf(index, chunk.filePath);
  const fields = injectedFields(index, chunk);
  const exceptions = thrownExceptions(chunk);
  const calls = collaboratorCalls(chunk, fields);
  const subject = lowerFirst(className);
  const isVoid = method.returnType === "void";

  const imports = new Set<string>();
  const addTypes = (type: string) => {
    for (const t of simpleTypes(type)) {
      const imp = javaImportFor(index, t, pkg);
      if (imp) imports.add(imp);
    }
  };
  method.params.forEach((p) => addTypes(p.type));
  addTypes(method.returnType);
  fields.forEach((f) => addTypes(f.type));
  exceptions.forEach((e) => addTypes(e));

  const arrange = method.params.map(
    (p) => `        ${p.type} ${p.name} = ${javaSampleValue(p.type, p.name)};`,
  );
  const args = method.params.map((p) => p.name).join(", ");
  const invocation = `${method.isStatic ? className : subject}.${method.name}(${args})`;
  const scenarios: string[] = [];
  const tests: string[] = [];

  const collaboratorHint =
    calls.length > 0
      ? [`        // Arrange: stub the collaborators this path uses: ${calls.join(", ")}`]
      : [];

  scenarios.push(
    isVoid
      ? "completes successfully for valid input"
      : "returns the expected result for valid input",
  );
  tests.push(
    [
      "    @Test",
      `    void ${method.name}_${isVoid ? "completesSuccessfully" : "returnsExpectedResult"}() {`,
      ...arrange,
      ...collaboratorHint,
      "",
      isVoid ? `        ${invocation};` : `        ${method.returnType} result = ${invocation};`,
      "",
      isVoid
        ? "        // Assert: verify the interactions and state changes this method is responsible for"
        : "        assertNotNull(result);",
      "    }",
    ].join("\n"),
  );

  for (const exception of exceptions) {
    scenarios.push(`throws ${exception}`);
    tests.push(
      [
        "    @Test",
        `    void ${method.name}_throws${exception}() {`,
        ...arrange,
        `        // Arrange: set up the condition that makes ${method.name} throw ${exception}`,
        "",
        `        assertThrows(${exception}.class, () -> ${invocation});`,
        "    }",
      ].join("\n"),
    );
  }

  for (const p of method.params.filter((p) => p.type === "boolean" || p.type === "Boolean")) {
    scenarios.push(`branch where ${p.name} is false`);
    tests.push(
      [
        "    @Test",
        `    void ${method.name}_when${capitalize(p.name)}IsFalse() {`,
        ...arrange.map((line) =>
          line.includes(` ${p.name} = `) ? `        ${p.type} ${p.name} = false;` : line,
        ),
        "",
        isVoid ? `        ${invocation};` : `        ${method.returnType} result = ${invocation};`,
        "",
        isVoid
          ? "        // Assert: the false branch's behaviour"
          : "        assertNotNull(result);",
        "    }",
      ].join("\n"),
    );
  }

  for (const p of method.params.filter((p) =>
    new RegExp(`\\b${p.name}\\s*==\\s*null`).test(chunk.text),
  )) {
    const expected = exceptions.includes("IllegalArgumentException")
      ? "IllegalArgumentException"
      : undefined;
    if (!expected) continue;
    scenarios.push(`rejects null ${p.name}`);
    tests.push(
      [
        "    @Test",
        `    void ${method.name}_rejectsNull${capitalize(p.name)}() {`,
        ...arrange.map((line) =>
          line.includes(` ${p.name} = `) ? `        ${p.type} ${p.name} = null;` : line,
        ),
        "",
        `        assertThrows(${expected}.class, () -> ${invocation});`,
        "    }",
      ].join("\n"),
    );
  }

  const usesMocks = fields.length > 0 || arrange.some((l) => l.includes("mock("));
  const header = [
    pkg ? `package ${pkg};\n` : "",
    "import static org.junit.jupiter.api.Assertions.*;",
    usesMocks ? "import static org.mockito.Mockito.*;" : "",
    "",
    ...[...imports].sort().map((i) => `import ${i};`),
    "import org.junit.jupiter.api.Test;",
    fields.length > 0 ? "import org.junit.jupiter.api.extension.ExtendWith;" : "",
    fields.length > 0 ? "import org.mockito.InjectMocks;" : "",
    fields.length > 0 ? "import org.mockito.Mock;" : "",
    fields.length > 0 ? "import org.mockito.junit.jupiter.MockitoExtension;" : "",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "");

  const testClass = `${className}${capitalize(method.name)}Test`;
  const body = [
    fields.length > 0 ? "@ExtendWith(MockitoExtension.class)" : "",
    `class ${testClass} {`,
    "",
    ...fields.map((f) => `    @Mock\n    private ${f.type} ${f.name};\n`),
    fields.length > 0
      ? `    @InjectMocks\n    private ${className} ${subject};\n`
      : method.isStatic
        ? ""
        : `    private final ${className} ${subject} = new ${className}();\n`,
    tests.join("\n\n"),
    "}",
  ].filter((line) => line !== "");

  const testDir = pkg
    ? `src/test/java/${pkg.replace(/\./g, "/")}`
    : path.posix.dirname(chunk.filePath);
  return {
    framework: "junit",
    testFilePath: `${testDir}/${testClass}.java`,
    className,
    method,
    scenarios,
    collaboratorCalls: calls,
    code: `${header.join("\n").trim()}\n\n${body.join("\n")}\n`,
  };
}

export function tsSampleValue(type: string, name: string): string {
  const t = type.trim();
  if (t === "string") return `"${name}"`;
  if (t === "number") return "1";
  if (t === "boolean") return "true";
  if (t.endsWith("[]") || t.startsWith("Array<")) return "[]";
  if (t === "unknown" || t === "any") return "undefined";
  return `{} as ${t}`;
}

function generateJest(index: CodebaseIndex, chunk: Chunk): TestSuggestion {
  if (!chunk.signature) throw new ToolInputError(`${chunk.id} has no parsable signature`);
  const method = parseTsSignature(chunk.signature);
  const moduleName = path.posix
    .basename(chunk.filePath)
    .replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
  const exceptions = thrownExceptions(chunk);
  const className = chunk.kind === "function" ? undefined : chunk.container;
  const typed = (p: Param) => (p.type === "unknown" ? "" : `: ${p.type}`);
  const arrange = method.params.map(
    (p) => `    const ${p.name}${typed(p)} = ${tsSampleValue(p.type, p.name)};`,
  );
  const args = method.params.map((p) => p.name).join(", ");
  const localTypes = new Set(
    index
      .chunksForFile(chunk.filePath)
      .filter((c) => c.kind === "class" && c.symbol && !c.container)
      .map((c) => c.symbol as string),
  );
  const typeImports = [
    ...new Set(method.params.flatMap((p) => simpleTypes(p.type)).filter((t) => localTypes.has(t))),
  ];

  let setup: string[] = [];
  let target = method.name;
  if (className) {
    const ctor = index
      .chunksForFile(chunk.filePath)
      .find((c) => c.container === className && c.kind === "constructor");
    const ctorParams = ctor?.signature ? parseTsSignature(ctor.signature).params : [];
    const ctorArgs = ctorParams.map((p) => tsSampleValue(p.type, p.name)).join(", ");
    setup = [`    const subject = new ${className}(${ctorArgs});`];
    target = method.isStatic ? `${className}.${method.name}` : `subject.${method.name}`;
  }
  const call = `${target}(${args})`;
  const awaitPrefix = method.isAsync ? "await " : "";
  const scenarios = ["returns the expected result for valid input"];
  const cases = [
    [
      `  it("returns the expected result for valid input", ${method.isAsync ? "async " : ""}() => {`,
      ...setup,
      ...arrange,
      "",
      `    const result = ${awaitPrefix}${call};`,
      "",
      "    expect(result).toBeDefined();",
      "  });",
    ].join("\n"),
  ];
  for (const exception of exceptions) {
    scenarios.push(`throws ${exception}`);
    const assertion = method.isAsync
      ? `    await expect(${call}).rejects.toThrow(${exception});`
      : `    expect(() => ${call}).toThrow(${exception});`;
    cases.push(
      [
        `  it("throws ${exception} on failure", ${method.isAsync ? "async " : ""}() => {`,
        ...setup,
        ...arrange,
        `    // Arrange: set up the condition that makes ${method.name} throw`,
        "",
        assertion,
        "  });",
      ].join("\n"),
    );
  }
  const imported = [...new Set([className ?? method.name, ...typeImports])].sort();
  const code = [
    `import { ${imported.join(", ")} } from "./${moduleName}";`,
    "",
    `describe("${className ? `${className}.` : ""}${method.name}", () => {`,
    cases.join("\n\n"),
    "});",
    "",
  ].join("\n");
  return {
    framework: "jest",
    testFilePath: `${path.posix.dirname(chunk.filePath)}/${moduleName}.test.ts`,
    ...(className ? { className } : {}),
    method,
    scenarios,
    collaboratorCalls: [],
    code,
  };
}

/** Builds a test skeleton for one method, choosing JUnit 5 + Mockito for Java and Jest for TS/JS. */
export function suggestTests(
  index: CodebaseIndex,
  chunk: Chunk,
  framework?: TestFramework,
): TestSuggestion {
  const chosen = framework ?? (chunk.language === "java" ? "junit" : "jest");
  if (chosen === "junit" && chunk.language !== "java") {
    throw new ToolInputError("JUnit skeletons are only generated for Java sources");
  }
  if (chosen === "jest" && chunk.language === "java") {
    throw new ToolInputError("Jest skeletons are only generated for TypeScript/JavaScript sources");
  }
  return chosen === "junit" ? generateJUnit(index, chunk) : generateJest(index, chunk);
}
