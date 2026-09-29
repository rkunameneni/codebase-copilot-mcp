# Prompts

Prompts are versioned files, not string literals buried in code. Each file is named
`<id>.v<N>.md` and starts with a small front-matter block (`id`, `version`, `purpose`, `used-by`).

- `loadPrompt(id)` picks the highest version present; `loadPrompt(id, { version })` pins one,
  which is how two prompt versions are compared side by side.
- Every answer and review records the prompt `id`, `version` and a 12-character content hash, so
  an output can always be traced to the exact prompt text that produced it.
- A behaviour change is a new file (`v2`), never an in-place edit of a version that has already
  produced results. Old versions stay for comparison until they are deliberately removed.

| File | Used by | Purpose |
| --- | --- | --- |
| `answer.system.v1.md` | `packages/rag/src/answer/answer.ts` | Citation-grounded Q&A over retrieved code, with an explicit refusal path |
| `review.system.v1.md` | `packages/agent/src/review/agent.ts` | System prompt for the tool-using code-review agent |
| `review.task.v1.md` | `packages/agent/src/review/agent.ts` | Per-run task message template (`{{target}}`, `{{content}}`) |

## Design notes

- **Structure over emphasis.** Instructions are short, explicit and ordered by importance.
  They explain *why* a rule exists (for example, why findings must point at real lines) instead
  of relying on capital letters.
- **Untrusted input is fenced.** Source code and diffs arrive inside XML-style tags, and both
  prompts say that text inside them is data, not instructions: a code comment saying "ignore
  previous instructions" must not steer the model.
- **A defined way out.** The answer prompt has a single, machine-checkable refusal form
  (`INSUFFICIENT_CONTEXT: ...`); the review prompt allows an empty findings list. Giving the
  model a legitimate exit reduces invented answers and invented findings.
- **Stable prefix for caching.** System prompts contain nothing that changes per request (no
  dates, ids or file names), so they can be cached; everything per-run goes in the task message.
