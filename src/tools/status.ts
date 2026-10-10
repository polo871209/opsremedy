
export function formatToolStatus(toolName: string, args: any): string {
  const trunc = (s: unknown, n = 80) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .slice(0, n);
  switch (toolName) {
    case "gcp_logging_query": {
      const f = trunc(args?.filter);
      return f ? `Querying GCP logs: \`${f}\`` : "Querying GCP logs";
    }
    case "promql_instant":
    case "promql_range": {
      const q = trunc(args?.query);
      return q ? `Running PromQL: \`${q}\`` : "Running PromQL";
    }
    case "jaeger_get_trace":
      return `Fetching trace ${trunc(args?.traceId, 24)}`;
    case "k8s_get_pods":
      return `Listing pods${args?.namespace ? ` in ${trunc(args.namespace, 40)}` : ""}`;
    case "k8s_pod_logs":
      return `Reading pod logs: ${trunc(args?.name, 40)}`;
    case "k8s_get_events":
      return "Fetching Kubernetes events";
    case "k8s_get_deployments":
      return "Listing deployments";
    case "k8s_rollout_history":
      return `Checking rollout history${args?.name ? `: ${trunc(args.name, 40)}` : ""}`;
    case "submit_diagnosis":
      return "Finalizing diagnosis\u2026";
    default:
      if (toolName.startsWith("prom_")) return "Discovering Prometheus metadata";
      return `Running ${toolName}`;
  }
}
