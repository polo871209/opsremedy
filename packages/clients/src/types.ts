import type {
  EventSummary,
  LogEntry,
  PodSummary,
  PromInstantResult,
  PromRuleState,
  PromSeriesResult,
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
   */
  uiUrl(filter: string, errorsOnly?: boolean): string | undefined;
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

export interface PromClient {
  instant(q: PromInstantQuery): Promise<PromInstantResult>;
  range(q: PromRangeQuery): Promise<PromSeriesResult>;
  alertRules(signal?: AbortSignal): Promise<PromRuleState[]>;
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

export interface K8sClient {
  listPods(q: K8sListPodsQuery): Promise<PodSummary[]>;
  describe(q: K8sDescribeQuery): Promise<string>;
  events(q: K8sEventsQuery): Promise<EventSummary[]>;
  podLogs(q: K8sLogsQuery): Promise<string[]>;
}

// ---------------- Registry ----------------

export interface ClientRegistry {
  gcp: GcpLoggingClient;
  prom: PromClient;
  jaeger: JaegerClient;
  k8s: K8sClient;
}
