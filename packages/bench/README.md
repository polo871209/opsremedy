# @opsremedy/bench

Synthetic scenario harness. Fixture clients per scenario, real LLM. Used to
measure regression on category accuracy, evidence coverage, and tool
trajectory.

## Scenario layout

`packages/bench/scenarios/<NNN-name>/`:

| file | content |
|------|---------|
| `alert.json` | input alert payload |
| `gcp_logs.json` | `FixtureGcpPayload` |
| `prom.json` | `FixturePromPayload` |
| `jaeger.json` | `FixtureJaegerPayload` |
| `k8s.json` | `FixtureK8sPayload` |
| `answer.yml` | expected category, keywords, forbidden, evidence sources, trajectory, max tool calls |

Add a scenario by copying an existing folder and editing.

## Scoring axes (`scoring.ts`)

| axis | passes when |
|------|-------------|
| `category_ok` | `report.root_cause_category === answer.expected_category` |
| `keywords_ok` | every `required_keywords` appears in claim/RC text (case-insensitive) |
| `not_forbidden` | category not in `forbidden_categories`, no `forbidden_keywords` hit |
| `evidence_ok` | every `required_evidence_sources` key is non-empty |
| `trajectory_ok` | every `optimal_trajectory` tool was called |
| `loops_ok` | total tool calls ≤ `max_tool_calls` |

`overall = all of the above`.

## Run

```
bun run bench                                  # all scenarios
bun run bench -- --scenario 005-recovered-healthy
bun run bench -- --json                        # machine-readable output
```

Hits the real LLM — needs working OAuth/key.

## Key files

| file | role |
|------|------|
| `runner.ts` | per-scenario gather → diagnose → validate; reuses `executePipeline` |
| `scoring.ts` | the six scoring axes |
| `load.ts` | scenario directory loader |
