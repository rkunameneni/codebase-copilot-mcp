# AI-assisted workflow

This document describes how AI tools were used to build this repository and how their output
was checked. It is deliberately specific: which steps were delegated, what the checks were, and
what the checks caught. It contains no productivity figures, because none were measured.

## How the repository was produced

The code, tests and documentation were generated with **Claude Code** (Anthropic's agentic
coding CLI) working from a written specification. The specification fixed the scope
(three packages, the tool list, the review-output schema), the engineering bar (strict
TypeScript, offline tests, lint, CI, Docker) and the constraints (no network in tests, no API
keys committed, path-traversal protection, honest documentation).

Claude Code was used for:

| Activity | What it did | How it was checked |
| --- | --- | --- |
| API research | Read current Anthropic SDK and MCP SDK type definitions in `node_modules` before writing calls (for example, confirming that `fallbacks`, `output_config.effort` and top-level `cache_control` exist on the beta Messages params in the installed SDK) | `tsc` against the installed SDKs; the request shape is asserted in `answer.test.ts` and `agent.test.ts` |
| Code generation | Wrote the chunker, retrieval, MCP server, agent loop and CLIs | Unit tests, typecheck, ESLint, stdio smoke test against the built server and the Docker image |
| Test generation | Wrote the Jest suites, including the scripted fake Anthropic client and the MCP in-memory transport tests | Tests were run and every failure was diagnosed before changing either the test or the code (see below) |
| Refactoring | Tightened parsing helpers, path resolution and tool-call bookkeeping after tests exposed problems | Full suite re-run after each change |
| Review | Reviewed its own diffs against the specification and the lint/type/test output | The checks listed in "Definition of done" in `CLAUDE.md` |

The same toolkit this repository ships (the `search_code` / `explain_symbol` tools and the review
agent) is designed for this loop: an assistant gathers context through narrow, audited tools and
returns structured, verifiable output instead of free text.

## What the automated checks caught during development

These are real issues found while building this repository, listed because they show why the
checks exist:

- **Parallel tool calls were logged in completion order.** The agent runs a turn's tool calls
  concurrently; the first implementation appended to the call log as each finished, so the log
  order varied between runs. A test asserting the order failed intermittently. The fix records
  calls in the order the model issued them.
- **A regex was silently weakened by string escaping.** The Jest transform pattern lost a
  backslash (`"^.+\.ts$"` instead of `"^.+\\.ts$"`), which still worked but matched more than
  intended. ESLint's `no-useless-escape` flagged it.
- **Test expectations were wrong, not the code.** Two chunker tests had off-by-one line numbers
  and a diff-rendering test had the wrong column spacing. Each was checked against the fixture
  by hand before the expectation was changed.
- **Ranking assertions were too brittle.** Tests that required a specific chunk at rank 1 failed
  because a test file (`InventoryServiceTest`) legitimately ranked first. The assertions were
  relaxed to "within the top k", and the eval (not the unit tests) is where ranking quality is
  measured.
- **Review paths were resolved against the wrong directory.** `copilot review src/Foo.java --root repo`
  failed because the path was resolved against the current directory only. It now tries the
  current directory, then the root, and still rejects anything outside the root.
- **An environment limitation, recorded rather than hidden.** Creating symlinks needs extra
  privileges on Windows, so the symlink-escape test is explicitly skipped there (`it.skip`) and
  runs in CI on Linux.

## Rules followed when using AI output

1. **Nothing is trusted because it looks right.** Every behaviour claimed in the README is backed
   by a test, the eval, or a smoke test that was actually run.
2. **Evals are reported as measured.** The retrieval numbers in the README come from
   `npm run eval`. On this small corpus, hybrid retrieval does not beat the vector leg at
   recall@3; the README says so instead of tuning the golden set until it does.
3. **Model output is validated like user input.** Tool inputs are parsed with zod, file paths go
   through the path guard, review findings are checked against real file lengths, and answer
   citations are checked against the retrieved line ranges.
4. **No live-model claims without a live run.** The test suite and the eval use scripted model
   responses and local embeddings. The README's example review output is labelled as coming from
   a scripted response for the same reason.

## What a human reviewer should still check

Before relying on this code, a reviewer should read, at minimum:

- `packages/mcp-server/src/security.ts` - the path guard is the main security boundary.
- `packages/agent/src/review/agent.ts` - the tool loop, stop-reason handling and grounding.
- `prompts/` - the instructions the model actually receives.
- The first live `copilot review` and `copilot ask` runs against a real key, comparing the
  logged token usage and cost with expectations.
