---
name: prompt-writing
description: >
  Reference for writing/editing LLM system prompts and tool descriptions in this repo.
  Compresses prose to caveman style, preserves intentions and code.
trigger: when authoring or editing any prompt string, tool description, or schema field
  description that an LLM will read at runtime.
---

# Prompt-writing skill (opsremedy)

Use whenever you touch:
- `packages/core/src/prompts.ts` (gather/diagnose system prompts)
- `packages/tools/src/*.ts` (`description` field on `defineTool`, TypeBox `description`)
- Any string sent to an LLM as instruction or tool spec.

Reference for tool-surface design: [`googleapis/gcloud-mcp`](https://github.com/googleapis/gcloud-mcp).
Their `observability-mcp/list_log_entries` is the size/shape target — short paragraph,
LQL doc link, a few example filters, no repeated warnings.

## Goals

1. **Preserve every behavioural intention.** Compression must not drop a rule the prompt was
   load-bearing for. Before editing, list the rules; after editing, verify each is still present.
2. **Cut tokens, not signal.** LLM context costs scale per call. Tool descriptions are
   re-sent on every tool-call round; system prompts on every turn.
3. **Move detail to where the LLM will see it.** Per-field hints belong in the TypeBox
   parameter `description`, not the tool's top-level `description`.
4. **One rule, one place.** No duplicate warnings across description + schema + summary.

## Caveman compression rules

Apply to prose only. Code, schemas, examples, identifiers stay byte-exact.

### Drop
- Articles: a / an / the
- Filler: just / really / basically / actually / simply / essentially
- Hedging: "it might be worth", "you could consider", "it would be good to"
- Pleasantries: "sure", "of course", "I'd recommend"
- Connective fluff: "however", "furthermore", "additionally"
- Redundant phrasing: "in order to" → "to"; "make sure to" → "ensure"
- Empty headers: `MISSION`, `TOOLS AVAILABLE`, `OVERVIEW` when body is one sentence

### Preserve EXACTLY
- Code blocks (fenced ``` and indented)
- Inline code (\`backtick content\`)
- URLs, file paths, commands
- JSON schema literals, TypeBox enum values, severity strings (`ERROR`, `WARNING`)
- Identifiers and proper nouns (`k8s_container`, `prometheus_target`, `Cloud Logging`)
- Numeric values, dates, version numbers

### Preserve structure
- Markdown headings (compress body, keep heading text)
- Bullet hierarchy and nesting level
- Numbered list ordering
- Tables (compress cells, keep grid)

### Compress
- Short synonyms: "use" not "utilize"; "fix" not "implement a solution for"
- Fragments OK: "Run tests before push" not "You should always run the test suite before pushing"
- Drop "you should" / "make sure to" / "remember to" — state the action
- Merge bullets that say the same thing differently
- One example beats three illustrating the same pattern

## Process

1. **List intentions.** Before editing, scan the prompt and write a checklist of every
   rule it enforces. Keep it next to the buffer.
2. **Compress prose only.** Treat code/JSON/examples as read-only regions.
3. **Move per-field guidance into schemas.** If the tool description explains what
   `filter` should look like, put it under `Type.String({ description: "..." })`. The LLM
   sees the schema next to the field it's filling.
4. **Verify intentions.** After editing, walk the checklist; each item must still be in
   the new text.
5. **Run tests + biome.** Schema/string changes are still TypeScript.

## Tool description shape (target)

Aim for ~80–150 tokens per tool description. Pattern:

```
<one sentence: what it does and when to use>
<hard rules: 1–2 lines, NEVER violations>
<one short example>
```

Per-field rules go in the parameter schema, not the description.

### Example: query_gcp_logs (current)

The tool description sets the framing and hard rules; the parameter schema teaches the
filter syntax. Mirrors gcloud-mcp's `list_log_entries` shape.

## Anti-patterns

- Repeating the same warning in description, schema, and runtime summary.
- Magic stop strings (`READY_TO_DIAGNOSE`) the runtime never enforces.
- Headers like `MISSION` followed by one sentence.
- Re-explaining a feature (`intent` object) the schema already documents.
- Examples that show three near-identical filters; one is enough.
- Adding new rules without first checking whether an existing rule covers the case.

## Categorization rubric (diagnose prompt)

Lifted into the diagnose prompt itself; do not duplicate elsewhere. Summary:

- Category describes the **alerted service's relationship to the failure**, not the
  upstream's deepest cause.
- `dependency` when service A is failing because depended-on service B is unavailable,
  even if B's underlying problem is OOM / deploy / unschedulable. The fix list can mention
  B's deeper cause; category stays `dependency`.
- `resource_exhaustion` only when the alerted service A itself is starved.
- `infrastructure` only for shared-platform issues with no single upstream service.
- `healthy` requires the word "recovered" or "resolved" in `root_cause` plus a cited
  recovery signal.

## Pre-commit checklist

- [ ] Listed every behavioural intention before editing.
- [ ] Verified each intention is still present after editing.
- [ ] Code blocks, schemas, examples, identifiers byte-exact.
- [ ] Per-field guidance in TypeBox `description`, not tool description.
- [ ] No duplicate warnings across description / schema / runtime summary.
- [ ] `bun test` green, `bun run check` clean.
