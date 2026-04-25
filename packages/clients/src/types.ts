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
}

// ---------------- Jaeger ----------------

export interface JaegerTracesQuery {
  service: string;
  operation?: string;
  /** Minimum duration in milliseconds to include. */
  minDurationMs?: number;
  lookbackMinutes: number;
  limit: number;
  signal?: AbortSignal;
}

export interface JaegerDepsQuery {
  service: string;
  lookbackMinutes: number;
  signal?: AbortSignal;
}

export interface JaegerClient {
  findTraces(q: JaegerTracesQuery): Promise<TraceSummary[]>;
  serviceDependencies(q: JaegerDepsQuery): Promise<ServiceDep[]>;
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
