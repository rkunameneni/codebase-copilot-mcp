---
id: review.task
version: 1
purpose: Per-run task message for the review agent. Variables: target (what is being reviewed), content (numbered files or a unified diff).
used-by: packages/agent/src/review/agent.ts
---
Review {{target}}.

<code_under_review>
{{content}}
</code_under_review>

Gather whatever context you need with the tools, then call submit_review once with your findings.
