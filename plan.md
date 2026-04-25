# OpsRemedy — Build Plan

SRE investigation agent on Bun + pi-mono targeting GCP Cloud Logging, Prometheus, Jaeger, and Kubernetes.

Status: v1 skeleton — CLI-only, local node process, fixture-first tests, real clients behind a thin interface.

## Goals

- Accept an alert JSON, run a two-phase agent (gather → diagnose), emit a structured RCA report JSON.
- Four signal sources: GCP Cloud Logging, Prometheus (PromQL), Jaeger traces, Kubernetes API.
- Read + suggest remediation only. Never auto-execute mutations.
- Synthetic benchmark suite from day 1 — fixtures drive the same agent, scored vs `answer.yml`.
- Bun-native runtime. TypeScript strict. Workspaces per package.

## Non-goals (v1)

- No webhook server, no Slack bot, no in-cluster deployment.
- No auto-remediation execution.
- No multi-cluster / multi-tenant support.
- No persistent history store (one investigation per CLI run).
- No LLM fine-tuning, no OpenRCA rubric judge.

## Stack

Runtime: Bun ≥ 1.3 (single-binary TS runner, native test runner, workspaces).

Core agent: `@mariozechner/pi-agent-core@0.70.2`, `@mariozechner/pi-ai@0.70.2`.

Tool schemas / validation: `typebox@1.1.33` (re-exported by pi-ai; we declare explicit dep for IDE).

Clients:

- `@google-cloud/logging@11.2.1` (ADC auth).
- `@kubernetes/client-node@1.4.0` (kubeconfig / in-cluster).
- Prometheus + Jaeger: native `fetch` (Bun built-in).

Config / parsing: `yaml@2.8.3` for `answer.yml`, native `JSON` for everything else.

Linter: Biome (Bun-friendly, matches pi-mono style). Config minimal.

Tests: `bun test` (native). Fixture-based scenarios under `packages/bench/scenarios`.

## Repository layout

```
opsremedy/
├── plan.md                         # this file
├── README.md                       # user-facing
├── package.json                    # workspaces root, scripts
├── bunfig.toml                     # bun runtime config
├── tsconfig.base.json              # strict TS config inherited by packages
├── biome.json                      # lint/format
├── .env.example                    # GOOGLE_APPLICATION_CREDENTIALS, PROM_URL, ...
├── .gitignore
├── packages/
│   ├── core/                       # orchestration (gather + diagnose)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts            # Alert, Evidence, InvestigationContext, RCAReport
│   │       ├── run.ts              # runInvestigation(alert): RCAReport
│   │       ├── gather.ts           # phase 1 agent
│   │       ├── diagnose.ts         # phase 2 agent (no tools, JSON output)
│   │       ├── prompts.ts          # system prompts
│   │       ├── validate.ts         # claim validation + RCAReport schema guard
│   │       └── util/
│   │           ├── time.ts
│   │           ├── json.ts         # extractJsonBlock, safeParse
│   │           └── render.ts       # optional markdown renderer
│   ├── clients/                    # thin API adapters, both real + fixture impls
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # client registry (injectable)
│   │       ├── types.ts            # GcpLoggingClient, PromClient, JaegerClient, K8sClient interfaces + shared types
│   │       ├── gcp/
│   │       │   ├── real.ts
│   │       │   └── fixture.ts
│   │       ├── prom/
│   │       │   ├── real.ts
│   │       │   └── fixture.ts
│   │       ├── jaeger/
│   │       │   ├── real.ts
│   │       │   └── fixture.ts
│   │       └── k8s/
│   │           ├── real.ts
│   │           └── fixture.ts
│   ├── tools/                      # AgentTool factories; one file per family
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # makeAllTools(ctx)
│   │       ├── gcp-logs.ts         # query_gcp_logs
│   │       ├── prometheus.ts       # query_prom_instant, query_prom_range, get_prom_alert_rules
│   │       ├── jaeger.ts           # query_jaeger_traces, get_jaeger_service_deps
│   │       ├── k8s.ts              # k8s_get_pods, k8s_describe, k8s_get_events, k8s_pod_logs
│   │       └── remediation.ts      # propose_remediation (sink-only)
│   ├── cli/                        # entry point binary
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── main.ts             # opsremedy investigate -i alert.json
│   └── bench/                      # synthetic suite
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── runner.ts           # iterate scenarios, score
│       │   ├── scoring.ts
│       │   └── load.ts             # scenario loader
│       └── scenarios/
│           ├── 000-healthy/
│           │   ├── alert.json
│           │   ├── gcp_logs.json
│           │   ├── prom.json
│           │   ├── jaeger.json
│           │   ├── k8s.json
│           │   └── answer.yml
│           ├── 001-oom-kill/
│           ├── 002-high-latency-downstream/
│           ├── 003-crashloop-bad-config/
│           └── 004-prom-alert-already-recovered/
└── examples/
    └── alerts/
        └── sample-k8s-alert.json
```

## Data model (locked)

```ts
// Alert the CLI receives
interface Alert {
  alert_id: string;
  alert_name: string;
  severity: "critical" | "warning" | "info";
  fired_at: string;                   // ISO8601
  labels: Record<string, string>;     // namespace, pod, service, cluster, container, ...
  annotations: Record<string, string>;
  summary: string;
  raw?: unknown;
}

// Accumulated during gather phase — tools mutate this
interface Evidence {
  gcp_logs?: LogEntry[];
  gcp_error_logs?: LogEntry[];

  prom_instant?: Record<string, PromInstantResult>;
  prom_series?: Record<string, PromSeriesResult>;
  prom_alert_rules?: PromRuleState[];

  jaeger_traces?: TraceSummary[];
  jaeger_service_deps?: ServiceDep[];

  k8s_pods?: PodSummary[];
  k8s_events?: EventSummary[];
  k8s_describe?: Record<string, string>;
  k8s_pod_logs?: Record<string, string[]>;

  remediation_proposals?: RemediationProposal[];
  [k: string]: unknown;
}

interface InvestigationContext {
  alert: Alert;
  evidence: Evidence;
  tools_called: ToolCallAudit[];
  loop_count: number;
  max_tool_calls: number;                     // hard cap; default 20
  started_at: number;
}

interface RCAReport {
  alert_id: string;
  root_cause: string;
  root_cause_category:
    | "resource_exhaustion" | "configuration" | "dependency"
    | "deployment" | "infrastructure" | "data_quality"
    | "healthy" | "unknown";
  confidence: number;                         // recomputed by code after claim validation
  causal_chain: string[];
  validated_claims: Array<{ claim: string; evidence_sources: string[] }>;
  unverified_claims: string[];
  remediation: RemediationProposal[];
  tools_called: string[];
  duration_ms: number;
}
```

## Agent flow

```
alert.json
  ↓
loadAlert()                    parse + shape check
  ↓
runInvestigation(alert):
  ctx = newContext(alert)
  ↓
  phase 1: gatherEvidence(ctx)
    pi-mono Agent with 11 tools
    systemPrompt = GATHER_SYSTEM_PROMPT(alert)
    user message = alert JSON + instructions
    beforeToolCall enforces ctx.max_tool_calls
    tools mutate ctx.evidence
    agent stops when LLM emits assistant message w/ no toolCalls
  ↓
  phase 2: diagnose(ctx)
    pi-mono Agent, tools = []
    prompt = DIAGNOSE_SYSTEM_PROMPT + render(ctx.alert, ctx.evidence)
    expects strict JSON output matching RCAReport shape
    retry once on parse failure with correction message
  ↓
  phase 3: validate(ctx, parsed)
    code-level claim check against ctx.evidence
    move unsupported claims to unverified_claims
    recompute confidence
  ↓
  emit RCAReport to stdout (JSON)
  optional: --markdown path → write sidecar
```

## Tool contract

Every tool is produced by a factory that closes over `ctx`:

```ts
(ctx: InvestigationContext) => AgentTool
```

Tool body:

1. Call the injected client (real or fixture).
2. Mutate `ctx.evidence.<key>`.
3. Append entry to `ctx.tools_called`.
4. Return a short text summary to the LLM (not the full blob).

Short summary rule — the LLM gets enough to decide next action but never the full payload. Diagnoser reads the full `ctx.evidence` directly from the rendered prompt.

## Tool catalog (v1)

| Tool | Signal | Side-effect |
|------|--------|-------------|
| `query_gcp_logs` | GCP Cloud Logging | `evidence.gcp_logs`, `evidence.gcp_error_logs` |
| `query_prom_instant` | Prometheus instant query | `evidence.prom_instant[query]` |
| `query_prom_range` | Prometheus range query | `evidence.prom_series[query]` |
| `get_prom_alert_rules` | Prometheus rules API | `evidence.prom_alert_rules` |
| `query_jaeger_traces` | Jaeger query API | `evidence.jaeger_traces` |
| `get_jaeger_service_deps` | Jaeger dependencies | `evidence.jaeger_service_deps` |
| `k8s_get_pods` | K8s API | `evidence.k8s_pods` |
| `k8s_describe` | K8s API | `evidence.k8s_describe[kind/name]` |
| `k8s_get_events` | K8s API | `evidence.k8s_events` |
| `k8s_pod_logs` | K8s API | `evidence.k8s_pod_logs[pod/container]` |
| `propose_remediation` | (sink only) | `evidence.remediation_proposals[]` |

## Client injection

A single module-level registry in `packages/clients/src/index.ts`:

```ts
let registry = {
  gcp:    new RealGcpLoggingClient() as GcpLoggingClient,
  prom:   new RealPromClient()       as PromClient,
  jaeger: new RealJaegerClient()     as JaegerClient,
  k8s:    new RealK8sClient()        as K8sClient,
};
export function getClients() { return registry; }
export function setClients(next: Partial<typeof registry>) { Object.assign(registry, next); }
```

CLI does nothing (uses defaults). Bench runner calls `setClients({ gcp: new FixtureGcpLoggingClient(...), ... })` per scenario.

## Claim validation

Code-level, runs after the diagnoser returns JSON. For each claim in `validated_claims`:

1. Derive required evidence keys from declared `evidence_sources` plus keyword heuristics on the claim text.
2. If the referenced evidence keys are empty in `ctx.evidence` → move claim to `unverified_claims`.
3. Recompute `confidence` = `validated / (validated + unverified)`; clamp to `[0, 1]`.

Start small (keyword map: "pod" → `k8s_pods` / `k8s_describe`, "log" → `gcp_logs`, "latency" → `prom_series` or `jaeger_traces`, ...). Grow as scenarios expose gaps.

## Configuration

`.env` variables (CLI reads via `Bun.env`):

- `OPSREMEDY_LLM_PROVIDER` — `anthropic` (default) or `openai`.
- `OPSREMEDY_LLM_MODEL` — model id (default `claude-sonnet-4-20250514`).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — read by pi-ai directly.
- `GOOGLE_APPLICATION_CREDENTIALS` — GCP ADC JSON path.
- `GCP_PROJECT_ID` — required for Cloud Logging.
- `PROM_URL`, `PROM_BEARER_TOKEN?`, `PROM_USER?`, `PROM_PASSWORD?`.
- `JAEGER_URL`, `JAEGER_TOKEN?`.
- `KUBECONFIG` — defaults to `~/.kube/config`.
- `OPSREMEDY_MAX_TOOL_CALLS` — default 20.

Missing required env → fail fast with a friendly message listing what's missing.

## CLI surface

```
opsremedy investigate -i <alert.json> [--markdown <path>] [--model <id>] [--max-tool-calls N]
opsremedy bench [--scenario <id>] [--json]
```

Both commands wire into `packages/cli/src/main.ts`. `bench` shells out to `packages/bench/src/runner.ts`.

Output: JSON RCAReport to stdout. Stderr carries progress lines ("gather…", "diagnose…", tool names). `--markdown` writes an extra human-readable file.

## Bench scoring

Per scenario:

- `category_ok` — report category equals `answer.expected_category`.
- `keywords_ok` — every `required_keywords` appears in `root_cause + causal_chain` (case-insensitive).
- `not_forbidden` — category not in `forbidden_categories` (when declared).
- `evidence_ok` — every key in `required_evidence_sources` is non-empty in `ctx.evidence`.
- `trajectory_ok` — every tool in `optimal_trajectory` shows up in `ctx.tools_called` (set membership).
- `loops_ok` — `ctx.tools_called.length ≤ answer.max_tool_calls`.
- `overall` — all of the above.

Runner emits per-scenario pass/fail + aggregate pass rate. Non-zero exit on failure.

## Build order (execution sequence)

Each step self-contained; run `bun test` and/or the CLI at the end of each to verify.

**Phase A — skeleton + bench-first**

1. Scaffold workspace: `package.json`, `bunfig.toml`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.env.example`, `README.md`.
2. `packages/core`: types + prompts + `run.ts` (gather+diagnose stubs) + validation stub.
3. `packages/clients`: interfaces + fixture implementations only.
4. `packages/tools`: all 11 tool factories using the client interface.
5. `packages/core`: real `gather.ts` + `diagnose.ts` calling pi-mono Agent.
6. Scenario `001-oom-kill/` with hand-crafted fixtures + `answer.yml`.
7. `packages/bench/runner.ts` + `scoring.ts` + `load.ts`.
8. `packages/cli/main.ts` with `bench` subcommand wired through bench runner.
9. Milestone: `bun run bench --scenario 001-oom-kill` returns pass.

**Phase B — real clients**

10. `RealGcpLoggingClient` via `@google-cloud/logging` + ADC.
11. `RealPromClient` via `fetch`.
12. `RealJaegerClient` via `fetch`.
13. `RealK8sClient` via `@kubernetes/client-node`.
14. `cli investigate` wiring (real clients by default).
15. Milestone: `opsremedy investigate -i examples/alerts/sample-k8s-alert.json` works end-to-end against a real cluster.

**Phase C — robustness**

16. Scenarios 000, 002, 003, 004.
17. Claim validation (replace stub with real implementation).
18. Diagnoser JSON parse retry + schema guard.
19. Token-aware evidence rendering (cap logs/traces passed into diagnoser prompt).
20. Markdown renderer.

**Phase D — polish**

21. Config file support (`~/.opsremedy/config.yml`).
22. Structured trace log (pi-mono event stream → JSONL) for debugging.
23. Axis-2-style selective fixture backends for adversarial scoring.

## Open decisions (revisit after Phase A)

- Default model: Sonnet 4 for both phases; split gather→cheaper later if cost is a problem.
- PromQL freedom: LLM writes free PromQL in v1; add templated helpers later.
- K8s cluster scope: single cluster v1, alert labels pick namespace; multi-cluster punt.
- Log severity default in `query_gcp_logs`: no default — LLM always specifies.
- Diagnoser model: keep inside `Agent` class (per pi-mono docs, provides barrier semantics) vs raw `complete()` (smaller, no history). Start with `Agent`.

## Risks tracked

- **Token blowup** — mitigated by per-tool short summary + capped list lengths; revisited in Phase C.
- **Bad PromQL** — surfaced as tool error returned to LLM (pi-mono auto-converts thrown errors to tool_result with `isError: true`).
- **K8s selector guessing** — mitigated by forcing LLM to use alert labels via system prompt examples.
- **Diagnoser returning prose not JSON** — retry once with correction; after two failures, fall back to a minimal RCAReport built from evidence only.
- **pi-mono version churn** — pin exact versions; no `^` on pi-mono deps.
- **Bun ecosystem gaps** — `@google-cloud/logging` relies on Node APIs that may differ in Bun; fallback plan: use `gcloud logging read` via subprocess if the SDK breaks.
</content>
</invoke>