import type { Alert, GatherPlanAudit, ToolPlanEntry } from "./types.ts";

export const ALL_TOOL_NAMES = [
  "discover_gcp_log_resources",
  "query_gcp_logs",
  "query_prom_instant",
  "query_prom_range",
  "get_prom_alert_rules",
  "query_jaeger_traces",
  "get_jaeger_service_deps",
  "k8s_cluster_info",
  "k8s_get_pods",
  "k8s_describe",
  "k8s_get_events",
  "k8s_pod_logs",
  "k8s_triage_pod",
  "propose_remediation",
] as const;

type ToolName = (typeof ALL_TOOL_NAMES)[number];

const BASE_TOOLS: ToolName[] = [
  "discover_gcp_log_resources",
  "query_gcp_logs",
  "query_prom_range",
  "get_prom_alert_rules",
  "propose_remediation",
];
const K8S_TOOLS: ToolName[] = [
  "k8s_get_pods",
  "k8s_describe",
  "k8s_get_events",
  "k8s_pod_logs",
  "k8s_triage_pod",
];
const TRACE_TOOLS: ToolName[] = ["query_jaeger_traces", "get_jaeger_service_deps"];

export function planGatherTools(alert: Alert, loop: number, rerouteHint?: string): GatherPlanAudit {
  if (loop > 0 || rerouteHint) return selectAll("reroute can need any source", loop);

  const text = alertText(alert);
  const selected = new Map<ToolName, string>();
  for (const tool of BASE_TOOLS) selected.set(tool, "baseline alert/log/metric/remediation coverage");

  if (hasK8sSignal(text, alert.labels)) {
    for (const tool of K8S_TOOLS) selected.set(tool, "alert contains Kubernetes workload signal");
  }

  if (hasTraceSignal(text, alert.labels)) {
    for (const tool of TRACE_TOOLS) selected.set(tool, "alert contains service/latency/dependency signal");
  }

  if (hasInfraSignal(text)) selected.set("query_prom_instant", "alert asks for current infra state");

  return buildPlan(selected, loop);
}

export function missingRequiredPlannedTools(alert: Alert, calledTools: string[]): ToolPlanEntry[] {
  const called = new Set(calledTools);
  const missing: ToolPlanEntry[] = [];
  if (hasMetricSignal(alertText(alert)) && !called.has("query_prom_range")) {
    missing.push({
      tool: "query_prom_range",
      reason: "metric/rate/latency alert needs time-series evidence",
    });
  }
  if (hasDependencyTraceSignal(alertText(alert))) {
    if (!called.has("query_jaeger_traces")) {
      missing.push({ tool: "query_jaeger_traces", reason: "latency/dependency alert needs trace evidence" });
    }
    if (!called.has("get_jaeger_service_deps")) {
      missing.push({
        tool: "get_jaeger_service_deps",
        reason: "latency/dependency alert needs dependency-map evidence",
      });
    }
  }
  return missing;
}

function selectAll(reason: string, loop: number): GatherPlanAudit {
  const selected = new Map<ToolName, string>();
  for (const tool of ALL_TOOL_NAMES) selected.set(tool, reason);
  return buildPlan(selected, loop);
}

function buildPlan(selected: Map<ToolName, string>, loop: number): GatherPlanAudit {
  const selectedTools: ToolPlanEntry[] = [];
  const omittedTools: ToolPlanEntry[] = [];
  for (const tool of ALL_TOOL_NAMES) {
    const reason = selected.get(tool);
    if (reason) selectedTools.push({ tool, reason });
    else omittedTools.push({ tool, reason: "no deterministic signal from alert" });
  }
  return { loop, selectedTools, omittedTools };
}

function alertText(alert: Alert): string {
  return [
    alert.alert_name,
    alert.summary,
    ...Object.entries(alert.labels).flat(),
    ...Object.entries(alert.annotations).flat(),
  ]
    .join(" ")
    .toLowerCase();
}

function hasK8sSignal(text: string, labels: Record<string, string>): boolean {
  return Boolean(
    labels.namespace ||
      labels.namespace_name ||
      labels.pod ||
      labels.pod_name ||
      labels.deployment ||
      labels.container ||
      /\b(k8s|kubernetes|pod|namespace|container|deployment|statefulset|job|node|crashloop|oomkilled|pending)\b/.test(
        text,
      ),
  );
}

function hasTraceSignal(text: string, labels: Record<string, string>): boolean {
  return Boolean(
    labels.service ||
      labels.service_name ||
      labels.operation ||
      /\b(service|latency|p95|p99|trace|jaeger|span|dependency|upstream|downstream|http 5|5xx)\b/.test(text),
  );
}

function hasInfraSignal(text: string): boolean {
  return /\b(cpu|memory|disk|network|saturation|utilization|usage|load|throttle)\b/.test(text);
}

function hasMetricSignal(text: string): boolean {
  return /\b(rate|latency|p95|p99|slo|error ratio|error_rate|errors? high)\b/.test(text);
}

function hasDependencyTraceSignal(text: string): boolean {
  return /\b(latency|p95|p99|trace|span|dependency|upstream|downstream)\b/.test(text);
}
