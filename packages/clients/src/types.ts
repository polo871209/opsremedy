import type {
  EventSummary,
  LogEntry,
  PodSummary,
  PromInstantResult,
  PromMetricMetadata,
  PromRuleState,
  PromSeriesResult,
  PromTarget,
  ServiceDep,
  TraceSummary,
} from "@opsremedy/core/types";

// ---------------- GCP Cloud Logging ----------------

export interface GcpLogsQuery {
  /** Cloud Logging filter expression. */
  filter: string;
  /** Inclusive start time. */
  from: Date;
  /** Inclusive end time. */
  to: Date;
  max: number;
  signal?: AbortSignal;
}

export interface GcpLoggingClient {
  search(q: GcpLogsQuery): Promise<LogEntry[]>;
  /**
   * Build a Cloud Logging UI URL for the given filter, or undefined when
   * the client has no project context (e.g. fixtures). Pure: no I/O.
   * `window` encodes the incident time range so the Console opens scoped
   * to the same interval the tool queried.
   */
  uiUrl(filter: string, errorsOnly?: boolean, window?: { from: Date; to: Date }): string | undefined;
}

// ---------------- Prometheus ----------------

export interface PromInstantQuery {
  query: string;
  time?: Date;
  signal?: AbortSignal;
}

export interface PromRangeQuery {
  query: string;
  start: Date;
  end: Date;
  /** Step duration in seconds. */
  step: number;
  signal?: AbortSignal;
}

export interface PromMetricsListQuery {
  /** Optional case-insensitive substring filter applied to metric names. */
  contains?: string;
  /** Cap returned names; defaults to 200. */
  limit?: number;
  signal?: AbortSignal;
}

export interface PromMetadataQuery {
  /** When set, return only metadata for this metric name. */
  metric?: string;
  /** Per-metric metadata limit returned by Prom (defaults to 1). */
  perMetricLimit?: number;
  signal?: AbortSignal;
}

export interface PromTargetsQuery {
  /** When set, return only targets whose `job` label matches. */
  job?: string;
  /** When "active"|"dropped"|"any" — defaults to "active". */
  state?: "active" | "dropped" | "any";
  signal?: AbortSignal;
}

export interface PromClient {
  instant(q: PromInstantQuery): Promise<PromInstantResult>;
  range(q: PromRangeQuery): Promise<PromSeriesResult>;
  alertRules(signal?: AbortSignal): Promise<PromRuleState[]>;
  /** List metric names known to the server (`/api/v1/label/__name__/values`). */
  listMetrics(q: PromMetricsListQuery): Promise<string[]>;
  /** Per-metric metadata: type/help/unit (`/api/v1/metadata`). */
  metricMetadata(q: PromMetadataQuery): Promise<PromMetricMetadata[]>;
  /** Scrape target health (`/api/v1/targets`). */
  targets(q: PromTargetsQuery): Promise<PromTarget[]>;
  /** UI URL for a query in /graph; falls back to the bare /graph or /alerts. */
  uiUrl(kind: "graph" | "alerts", query?: string): string | undefined;
}

// ---------------- Jaeger ----------------

export interface JaegerTracesQuery {
  service: string;
  operation?: string;
  /** Minimum duration in milliseconds to include. */
  minDurationMs?: number;
  lookbackMinutes: number;
  limit: number;
  /**
   * End of the search window. Defaults to wall-clock now if absent. Tools
   * pass alert.fired_at so historical alerts find the traces that actually
   * coincided with the incident, not whatever happens to be fresh now.
   */
  endTime?: Date;
  signal?: AbortSignal;
}

export interface JaegerDepsQuery {
  service: string;
  lookbackMinutes: number;
  /** End of the dependency-aggregation window; same semantics as on traces. */
  endTime?: Date;
  signal?: AbortSignal;
}

export interface JaegerClient {
  findTraces(q: JaegerTracesQuery): Promise<TraceSummary[]>;
  serviceDependencies(q: JaegerDepsQuery): Promise<ServiceDep[]>;
  /** UI URL for the search or dependencies page; service narrows traces. */
  uiUrl(kind: "search" | "dependencies", service?: string): string | undefined;
}

// ---------------- Kubernetes ----------------

export interface K8sListPodsQuery {
  namespace: string;
  labelSelector?: string;
  fieldSelector?: string;
  signal?: AbortSignal;
}

export interface K8sDescribeQuery {
  kind: "pod" | "deployment" | "node" | "service" | "job" | "statefulset";
  name: string;
  namespace?: string;
  signal?: AbortSignal;
}

export interface K8sEventsQuery {
  namespace: string;
  fieldSelector?: string;
  signal?: AbortSignal;
}

export interface K8sLogsQuery {
  namespace: string;
  pod: string;
  container?: string;
  tailLines: number;
  previous?: boolean;
  signal?: AbortSignal;
}

/**
 * Coarse cluster-level facts. Used by `k8s_cluster_info` to give the
 * gather agent cheap context (node health summary + namespace list)
 * without spending a tool call per kind. Server version omitted to
 * keep the call cheap and to avoid pulling another API client.
 */
export interface ClusterInfo {
  nodes: { total: number; ready: number };
  namespaces: string[];
}

export interface K8sClient {
  listPods(q: K8sListPodsQuery): Promise<PodSummary[]>;
  describe(q: K8sDescribeQuery): Promise<string>;
  events(q: K8sEventsQuery): Promise<EventSummary[]>;
  podLogs(q: K8sLogsQuery): Promise<string[]>;
  /** Return server version + node + namespace summary. */
  clusterInfo(signal?: AbortSignal): Promise<ClusterInfo>;
}

// ---------------- Registry ----------------

export interface ClientRegistry {
  gcp: GcpLoggingClient;
  prom: PromClient;
  jaeger: JaegerClient;
  k8s: K8sClient;
}
