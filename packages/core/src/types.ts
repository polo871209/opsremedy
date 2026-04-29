/** Shared data model for the whole agent. */

export type Severity = "critical" | "warning" | "info";

export interface Alert {
  alert_id: string;
  alert_name: string;
  severity: Severity;
  /** ISO8601 timestamp of when the alert fired. */
  fired_at: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  summary: string;
  /** Original payload from the alert system, passed through untouched. */
  raw?: unknown;
}

// -------------------- evidence shapes --------------------

export interface LogEntry {
  timestamp: string;
  severity: string;
  /** Short rendered preview (single line). Full payload lives in `payload`. */
  textPreview: string;
  payload?: Record<string, unknown>;
  /** Cloud Logging monitored resource type, e.g. "k8s_container", "gce_instance". */
  resourceType?: string;
  resource?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface PromSample {
  timestamp: number; // seconds
  value: number;
}

export interface PromInstantResult {
  /** `scalar`, `vector`, or `matrix` matches Prom API. */
  resultType: "scalar" | "vector" | "matrix" | "string";
  /** Vector: per-series scalar; scalar: single value. */
  series: Array<{ metric: Record<string, string>; value: PromSample }>;
}

export interface PromSeriesResult {
  series: Array<{ metric: Record<string, string>; values: PromSample[] }>;
}

export interface PromRuleState {
  name: string;
  state: "firing" | "pending" | "inactive";
  query: string;
  labels: Record<string, string>;
  /** Unix seconds when rule transitioned to current state. */
  lastTransition?: number;
}

/**
 * Per-metric metadata from Prometheus `/api/v1/metadata`. Same shape across
 * vanilla Prom + Google Managed Prometheus. Lets the LLM tell counter from
 * gauge from histogram before writing rate() over a gauge.
 */
export interface PromMetricMetadata {
  metric: string;
  type: "counter" | "gauge" | "histogram" | "summary" | "untyped" | "info" | "stateset" | "unknown";
  help: string;
  unit?: string;
}

/**
 * Scrape target health from Prometheus `/api/v1/targets`. Single entry per
 * (job, instance). `lastError` is empty when the target is healthy.
 */
export interface PromTarget {
  job: string;
  instance: string;
  health: "up" | "down" | "unknown";
  scrapeUrl?: string;
  lastError?: string;
  lastScrape?: string;
  labels: Record<string, string>;
}

export interface TraceSummary {
  traceId: string;
  rootService: string;
  rootOperation: string;
  durationMs: number;
  hasError: boolean;
  spanCount: number;
  /** Brief text summary of the slowest or errored span in the trace. */
  noteworthySpan?: string;
}

export interface ServiceDep {
  parent: string;
  child: string;
  callCount: number;
}

export interface PodSummary {
  namespace: string;
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  /** Reason from the last terminated container state if any (e.g. OOMKilled). */
  lastTerminationReason?: string;
  node?: string;
  /**
   * Top-level owner workload, resolved by walking ownerReferences (e.g.
   * "Deployment/payments-api"). Lets evidence + Lark cards collapse pod
   * lists to the workload that actually matters. Optional: not populated
   * when the pod has no owner or the walk hit a kind we don't recognize.
   */
  owner?: string;
}

export interface EventSummary {
  namespace: string;
  involvedKind: string;
  involvedName: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  lastSeen: string;
}

export interface RemediationProposal {
  description: string;
  /** kubectl command or manifest patch. Dry-run only — never executed. */
  command?: string;
  risk: "low" | "medium" | "high";
}

/**
 * Structured per-resource health finding. Emitted by deterministic analyzers
 * (and, optionally, by the diagnose LLM). Renders as a compact table in the
 * Lark card, separate from the narrative root cause.
 *
 * Adapted from k8sgpt-ai/k8sgpt `Result + Failure` (pkg/common/types.go).
 * Kept narrow: one finding per (kind, name) with a single text field. Multi-
 * issue resources should produce multiple findings.
 */
export interface ResourceFinding {
  /** Kubernetes Kind, e.g. "Pod", "Deployment", "Service". */
  kind: string;
  /** Resource name within `namespace` (or `kind`-scope name for cluster res). */
  name: string;
  namespace?: string;
  /**
   * Top-level workload label resolved via ownerReferences walk, e.g.
   * "Deployment/payments-api". Set when relevant; lets the card collapse
   * 30 ReplicaSet pods to one row.
   */
  parent?: string;
  /** Human-readable failure description (one line preferred). */
  text: string;
  severity: "critical" | "warning" | "info";
  /** Where this finding came from. */
  source: "deterministic" | "llm";
}

export interface EvidenceProvenanceEntry {
  tool: string;
  args: unknown;
  loop: number;
  summary: string;
}

export interface ToolCallAudit {
  name: string;
  args: unknown;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Per-tool-call audit entry capturing intent, outcome, and which evidence
 * keys the call wrote. Mirrors `tools_called` for the legacy view but adds
 * loop, summary, and evidence diff so reroute logic + bench scoring can
 * reason about trajectory without re-derivation.
 */
export interface AuditEntry {
  /** Reroute loop in which the call ran (0 for the first gather pass). */
  loop: number;
  tool: string;
  args: unknown;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  errorMessage?: string;
  /** Short text the gathering agent saw as the tool result. */
  summary: string;
  /** Evidence keys that became populated (or grew) as a result of this call. */
  evidenceKeys: string[];
}

export interface ToolPlanEntry {
  tool: string;
  reason: string;
}

export interface GatherPlanAudit {
  loop: number;
  selectedTools: ToolPlanEntry[];
  omittedTools: ToolPlanEntry[];
}

export interface Evidence {
  gcp_logs?: LogEntry[];
  gcp_error_logs?: LogEntry[];

  prom_instant?: Record<string, PromInstantResult>;
  prom_series?: Record<string, PromSeriesResult>;
  prom_alert_rules?: PromRuleState[];
  prom_metrics?: string[];
  prom_metric_metadata?: PromMetricMetadata[];
  prom_targets?: PromTarget[];

  jaeger_traces?: TraceSummary[];
  jaeger_service_deps?: ServiceDep[];

  k8s_pods?: PodSummary[];
  k8s_events?: EventSummary[];
  k8s_describe?: Record<string, string>;
  k8s_pod_logs?: Record<string, string[]>;

  remediation_proposals?: RemediationProposal[];

  /**
   * Per-source deep-link URLs populated by tools as they query. Keyed by
   * EvidenceKey (e.g. "gcp_logs", "jaeger_traces"). Read by the notifier to
   * linkify claim sources; never consumed by the diagnoser.
   */
  evidence_links?: Partial<Record<string, string>>;

  [key: string]: unknown;
}

// -------------------- agent state --------------------

export interface InvestigationContext {
  alert: Alert;
  evidence: Evidence;
  tools_called: ToolCallAudit[];
  /** Completed tool calls; compared against `max_tool_calls`. */
  loop_count: number;
  /**
   * Tool calls dispatched but not yet finished. Bumped synchronously in
   * `beforeToolCall`, decremented when `recordToolCall` runs. Lets the
   * budget gate account for parallel batches.
   */
  inflight: number;
  max_tool_calls: number;
  started_at: number;
  /** Current reroute loop number; 0 for first gather pass. */
  loop: number;
  /** Structured per-tool-call audit, parallel to `tools_called`. */
  audit: AuditEntry[];
  /** Deterministic tool-selection audit before each gather pass. */
  plan_audit: GatherPlanAudit[];
}

// -------------------- output --------------------

export type RootCauseCategory =
  | "resource_exhaustion"
  | "configuration"
  | "dependency"
  | "deployment"
  | "infrastructure"
  | "data_quality"
  | "healthy"
  | "unknown";

export interface ValidatedClaim {
  claim: string;
  evidence_sources: string[];
}

/**
 * Aggregate token + cost usage for an investigation. Identical shape lives
 * in `util/usage.ts` as `UsageTotal` (kept as an alias for back-compat with
 * pi-mono message rollups). One canonical definition; one zero value.
 */
export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export const ZERO_USAGE: UsageSummary = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  cost_usd: 0,
};

export interface RCAReport {
  alert_id: string;
  root_cause: string;
  root_cause_category: RootCauseCategory;
  /** Recomputed by code after claim validation; not trusted from LLM output. */
  confidence: number;
  causal_chain: string[];
  validated_claims: ValidatedClaim[];
  unverified_claims: string[];
  remediation: RemediationProposal[];
  /**
   * Structured per-resource findings (deterministic analyzers + optional
   * LLM). Parallel to the narrative `causal_chain` and `validated_claims`;
   * renders as its own Lark card section. Empty when no analyzer ran.
   */
  findings?: ResourceFinding[];
  tools_called: string[];
  duration_ms: number;
  /** Aggregate token + cost usage across both phases. */
  usage: UsageSummary;
  /**
   * Deep-link URLs per evidence source key, copied from `Evidence.evidence_links`
   * by the pipeline. Optional; consumers (e.g. Lark notifier) treat missing
   * entries as plain text. Not used by the LLM at any phase.
   */
  evidence_links?: Partial<Record<string, string>>;
  /** Evidence key → tool calls that populated it. */
  evidence_provenance?: Record<string, EvidenceProvenanceEntry[]>;
}

// -------------------- constants --------------------

export const ALL_EVIDENCE_KEYS = [
  "gcp_logs",
  "gcp_error_logs",
  "prom_instant",
  "prom_series",
  "prom_alert_rules",
  "prom_metrics",
  "prom_metric_metadata",
  "prom_targets",
  "jaeger_traces",
  "jaeger_service_deps",
  "k8s_pods",
  "k8s_events",
  "k8s_describe",
  "k8s_pod_logs",
  "remediation_proposals",
] as const;

export type EvidenceKey = (typeof ALL_EVIDENCE_KEYS)[number];
