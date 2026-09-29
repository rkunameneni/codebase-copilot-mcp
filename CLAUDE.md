# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

A TypeScript npm-workspaces monorepo that makes a source repository queryable by AI agents:

- `packages/rag` - ingestion, language-aware chunking, BM25 + vector hybrid retrieval, citation-grounded answers with Claude, retry/usage/prompt utilities, the retrieval eval runner.
- `packages/mcp-server` - MCP server (stdio) exposing `search_code`, `get_file_snippet`, `explain_symbol`, `find_references`, `suggest_tests` and the `codebase://files` resource. Tool definitions live in `src/tools.ts` and are shared with the agent.
- `packages/agent` - `copilot` CLI: `index`, `search`, `ask`, `review`. The review agent is a manual Claude tool-use loop in `src/review/agent.ts`.
- `prompts/` - versioned prompt files (`<id>.v<N>.md`). `evals/` - golden retrieval cases and runner. `sample-repo/` - Java/TS fixture used by tests, evals and demos.

Dependency direction: `agent -> mcp-server -> rag`. Never import upward.

## Commands

```bash
npm ci                     # install (Node 20+)
npm run build              # tsc -b for all packages
npm test                   # Jest; must pass with no network and no API keys
npm run test:coverage      # enforces global coverage thresholds (jest.config.js)
npm run lint               # typecheck + ESLint + Prettier check
npm run format             # Prettier write
npm run eval               # offline retrieval eval (needs a build first)
npm run smoke:mcp          # spawns the built MCP server over stdio and calls it
```

Run one test file: `npx jest packages/rag/test/chunker.test.ts`.

## Rules for changes

- **Tests stay offline.** Anything that calls Claude depends on the `MessagesClient` interface (`packages/rag/src/llm/client.ts`); tests pass a scripted fake. Voyage tests inject `fetchImpl`. Never add a test that needs `ANTHROPIC_API_KEY` or the network.
- **File access goes through `resolveIndexedFile` / `readIndexedFile`** (`packages/mcp-server/src/security.ts`). They enforce root containment (lexical and `realpath`), indexed-files-only and size limits. Do not add `fs.readFile` calls on model-supplied paths anywhere else.
- **Prompts are versioned files.** To change model behaviour, add `prompts/<id>.v<N+1>.md` rather than editing a version that has produced results, then run the evals and the agent tests. Keep system prompts free of per-request data so they stay cacheable.
- **Keep the agent's history append-only.** The assistant turn is pushed back exactly as received (thinking blocks included); tool results from one turn go back in a single user message. Editing earlier turns breaks prompt caching.
- **Model defaults** are in `packages/rag/src/llm/client.ts` (`claude-opus-5`, refusal fallback on). Override with `COPILOT_MODEL` / `COPILOT_EFFORT` / `COPILOT_REFUSAL_FALLBACK`; do not hard-code model IDs elsewhere.
- **Retrieval changes need eval evidence.** If you touch tokenization, chunking, BM25, embeddings or fusion, run `npm run build && npm run eval` before and after and put both tables in the PR description. Do not edit `evals/golden.json` to make a change look better.
- Adding an MCP tool: define it with a zod schema in `packages/mcp-server/src/tools.ts`, add it to `TOOLS`, test the handler directly through `callTool`, and update the tool list assertions in `server.test.ts`, `agent.test.ts` and `scripts/mcp-smoke.mjs`.

## Definition of done

`npm run lint`, `npm run test:coverage`, `npm run build`, `npm run eval` and `npm run smoke:mcp` all pass locally, and the README still matches behaviour (tool list, CLI flags, eval table if retrieval changed).
