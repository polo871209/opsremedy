# @opsremedy/tools

The 14 read-only tools the gather agent calls. Each is a pi-mono `AgentTool`
factory that takes the `InvestigationContext` and returns a tool with a
TypeBox parameter schema.

## Tools

| name | does |
|------|------|
| `discover_gcp_log_resources` | Cheap sample sweep that returns top resource.types, namespaces, pod/container names, and severity counts in the alert window. Call this first to avoid guessing labels. |
| `query_gcp_logs` | Cloud Logging filter around alert time |
| `query_prom_instant` | PromQL at a single timestamp |
| `query_prom_range` | PromQL over a window (range query) |
| `get_prom_alert_rules` | List alerting rules + state |
| `query_jaeger_traces` | Find traces for a service |
| `get_jaeger_service_deps` | Upstream/downstream edges |
| `k8s_cluster_info` | Cluster-level facts: node ready count + namespace list |
| `k8s_get_pods` | List pods in a namespace (incl. owner workload) |
| `k8s_describe` | `kubectl describe` equivalent |
| `k8s_get_events` | Namespace events; pass `object_name`/`object_kind` to scope |
| `k8s_pod_logs` | Tail container logs (supports `previous` for crash-loops) |
| `k8s_triage_pod` | One-shot: describe + events + logs for a single pod (replaces 3-4 calls) |
| `propose_remediation` | Record a dry-run fix (never executes) |

## defineTool contract

`defineTool({ name, label, description, parameters, ctx, run })` wraps the
boilerplate:
- times the call (`ms`)
- records audit via `recordToolCall` (success or error)
- decrements `ctx.inflight` in finally (pairs with the budget gate in
  `core/gather.ts:reserveToolCallSlot`)
- shapes `{summary, details}` into the pi-mono `AgentToolResult`

The body just does work and returns `{summary, details}`. `summary` is
short text the gather agent sees; the full payload is mutated onto
`ctx.evidence.<key>` for the diagnoser to read later.

## Shared helpers (`shared.ts`)

- `alertTime(ctx)` — parse `alert.fired_at`, fallback to `now()`
- `alertEndTime(ctx)` — `annotations.closed_at` if alert resolved, else `now()`
- `windowAroundAlert(ctx, before)` — `[fired - 5m - before, alertEnd]`
- `appendEvidence(ctx, key, items)` — array-shaped bucket append
- `setEvidenceMapEntry(ctx, key, subKey, value)` — record-shaped bucket set
- `truncate(text, max)` — keep summaries small
- `recordToolCall(ctx, entry)` — audit + bump `loop_count`
