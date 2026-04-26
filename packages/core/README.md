# @opsremedy/core

Shared types and the investigation pipeline. Imports clients (registry) and
tools; depends on `@mariozechner/pi-agent-core` for LLM agent runtime.

## Pipeline

`runInvestigation(alert)` → `executePipeline(ctx)`:

1. **gather** (`gather.ts`) — pi-mono `Agent` w/ 11 tools, parallel exec.
   `reserveToolCallSlot` enforces `max_tool_calls` even under parallel batches.
2. **diagnose** (`diagnose.ts`) — no tools, strict JSON, 1 retry. Falls back to
   a stub `{category: "unknown", confidence: 0}` on persistent parse failure.
3. **validate** (`validate.ts`) — code-level claim check against `ctx.evidence`,
   recompute confidence as `validated / total`.

## Key files

| file | role |
|------|------|
| `run.ts` | top-level entry (`runInvestigation`) used by CLI |
| `pipeline.ts` | shared 3-phase orchestration; bench reuses |
| `gather.ts` | phase 1 + budget gate (`reserveToolCallSlot`) |
| `diagnose.ts` | phase 2 + JSON extraction loop |
| `validate.ts` | phase 3 + `KEYWORD_EVIDENCE_MAP` |
| `prompts.ts` | system prompts for both phases |
| `types.ts` | canonical data model (`Alert`, `Evidence`, `RCAReport`) |
| `util/usage.ts` | token + cost rollup (`UsageTotal` aliases `UsageSummary`) |
| `util/render-evidence.ts` | size-capped JSON view fed to diagnoser |
| `util/thinking.ts` | streaming thinking renderer |
| `util/json.ts` | tolerant JSON extractor (fences, prose-wrapped) |
| `util/trace.ts` | append-only JSONL trace writer |

## Run

```
bun test packages/core
bunx tsc --noEmit -p packages/core/tsconfig.json
```
