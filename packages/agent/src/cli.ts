#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  answerQuestion,
  claudeConfigFromEnv,
  createAnthropicMessagesClient,
  DEFAULT_INDEX_DIR,
  DEFAULT_INDEX_FILE,
  CodebaseIndex,
  embeddingProviderFromEnv,
  openIndex,
  type RetrievalMode,
} from "@codebase-copilot/rag";
import { createContext, ToolInputError } from "@codebase-copilot/mcp-server";
import { stderrLogger } from "./logger";
import { ReviewAgent } from "./review/agent";
import { formatOutcome } from "./review/format";
import { gitDiff, targetFromDiff, targetFromPaths, type ReviewTarget } from "./review/targets";

const USAGE = `copilot - query and review a codebase with Claude

Usage:
  copilot index [--root <dir>] [--out <file>]
  copilot search <query> [--root <dir>] [--k <n>] [--mode hybrid|bm25|vector]
  copilot ask <question> [--root <dir>] [--k <n>] [--dry-run]
  copilot review <path...> [--root <dir>] [options]
  copilot review --diff [<base>] [--root <dir>] [options]
  copilot review --diff-file <patch> [--root <dir>] [options]

Review options:
  --format text|json      Output format (default text)
  --max-iterations <n>    Cap on model calls (default 8)
  --dry-run               Print the first request instead of calling the API

Environment: ANTHROPIC_API_KEY (ask/review), COPILOT_MODEL, COPILOT_EFFORT,
COPILOT_REFUSAL_FALLBACK, COPILOT_EMBEDDINGS, VOYAGE_API_KEY. See .env.example.`;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function loadIndex(root: string) {
  const started = Date.now();
  const { index, source } = await openIndex(root, { embeddings: embeddingProviderFromEnv() });
  stderrLogger.event("index_ready", {
    source,
    files: index.files.length,
    chunks: index.chunks.length,
    ms: Date.now() - started,
  });
  return index;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      out: { type: "string" },
      k: { type: "string" },
      mode: { type: "string", default: "hybrid" },
      format: { type: "string", default: "text" },
      "max-iterations": { type: "string" },
      diff: { type: "boolean", default: false },
      "diff-file": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    print(USAGE);
    return command || values.help ? 0 : 1;
  }
  const root = path.resolve(values.root);
  const k = values.k ? Number(values.k) : 8;
  if (!Number.isInteger(k) || k < 1 || k > 50)
    throw new ToolInputError("--k must be an integer from 1 to 50");

  switch (command) {
    case "index": {
      const out = path.resolve(
        values.out ?? path.join(root, DEFAULT_INDEX_DIR, DEFAULT_INDEX_FILE),
      );
      const started = Date.now();
      const index = await CodebaseIndex.build(root, { embeddings: embeddingProviderFromEnv() });
      await index.save(out);
      print(
        `Indexed ${index.files.length} files into ${index.chunks.length} chunks in ${Date.now() - started} ms -> ${out}`,
      );
      return 0;
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) throw new ToolInputError("search needs a query");
      if (!["hybrid", "bm25", "vector"].includes(values.mode))
        throw new ToolInputError("--mode must be hybrid, bm25 or vector");
      const index = await loadIndex(root);
      const result = await index.search(query, { k, mode: values.mode as RetrievalMode });
      for (const hit of result.hits) {
        const c = hit.chunk;
        const name = c.symbol ? ` ${c.container ? `${c.container}.` : ""}${c.symbol}` : "";
        print(
          `${c.filePath}:${c.startLine}-${c.endLine}  [${c.kind}${name}]  bm25#${hit.bm25Rank ?? "-"} vec#${hit.vectorRank ?? "-"}`,
        );
      }
      const conf = result.confidence;
      print(
        `confidence: ${conf.lowConfidence ? `LOW (${conf.reason})` : "ok"}; term coverage ${(conf.termCoverage * 100).toFixed(0)}%`,
      );
      return 0;
    }
    case "ask": {
      const question = rest.join(" ");
      if (!question) throw new ToolInputError("ask needs a question");
      const index = await loadIndex(root);
      const retrieval = await index.search(question, { k });
      if (values["dry-run"]) {
        print(
          JSON.stringify(
            { confidence: retrieval.confidence, sources: retrieval.hits.map((h) => h.chunk.id) },
            null,
            2,
          ),
        );
        return 0;
      }
      const config = claudeConfigFromEnv(process.env, { effort: "medium" });
      const answer = await answerQuestion(question, retrieval, {
        client: createAnthropicMessagesClient(),
        config,
      });
      if (answer.status === "refused") print(`Not answered: ${answer.refusalReason}`);
      else print(answer.answer);
      if (answer.status === "ungrounded")
        print(
          "\nWarning: none of the citations in this answer could be verified against the retrieved code.",
        );
      if (answer.invalidCitations.length > 0)
        print(`\nUnverified citations: ${answer.invalidCitations.join(", ")}`);
      stderrLogger.event("answer", {
        status: answer.status,
        prompt: answer.prompt,
        ...answer.usage,
        costUsd: answer.costUsd ?? null,
      });
      return answer.status === "answered" ? 0 : 2;
    }
    case "review": {
      const index = await loadIndex(root);
      let target: ReviewTarget;
      if (values["diff-file"]) {
        const patch = await fs.readFile(path.resolve(values["diff-file"]), "utf8");
        target = await targetFromDiff(index, patch, values["diff-file"]);
      } else if (values.diff) {
        const base = rest[0] ?? "HEAD";
        target = await targetFromDiff(index, await gitDiff(root, base), `git diff ${base}`);
      } else {
        if (rest.length === 0)
          throw new ToolInputError("review needs a path, --diff or --diff-file");
        target = await targetFromPaths(index, rest);
      }
      const maxIterations = values["max-iterations"] ? Number(values["max-iterations"]) : 8;
      if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 30) {
        throw new ToolInputError("--max-iterations must be an integer from 1 to 30");
      }
      const agent = new ReviewAgent({
        client: createAnthropicMessagesClient(),
        config: claudeConfigFromEnv(process.env, { effort: "high" }),
        tools: createContext(index),
        maxIterations,
        logger: stderrLogger,
      });
      if (values["dry-run"]) {
        print(JSON.stringify(agent.initialRequest(target), null, 2));
        return 0;
      }
      const outcome = await agent.review(target);
      print(values.format === "json" ? JSON.stringify(outcome, null, 2) : formatOutcome(outcome));
      return outcome.status === "completed" ? 0 : 2;
    }
    default:
      print(USAGE);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      error instanceof ToolInputError ? `Error: ${message}` : `Unexpected error: ${message}`,
    );
    process.exitCode = 1;
  });
