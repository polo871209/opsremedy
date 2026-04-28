import { describe, expect, it } from "bun:test";
import { missingRequiredPlannedTools, planGatherTools } from "./planner.ts";
import type { Alert } from "./types.ts";

const baseAlert: Alert = {
  alert_id: "a1",
  alert_name: "High error rate",
  severity: "critical",
  fired_at: "2026-01-01T00:00:00Z",
  labels: {},
  annotations: {},
  summary: "errors increased",
};

describe("planGatherTools", () => {
  it("adds Kubernetes tools for pod alerts", () => {
    const plan = planGatherTools({ ...baseAlert, labels: { namespace: "prod", pod: "api-abc" } }, 0);
    const tools = plan.selectedTools.map((t) => t.tool);

    expect(tools).toContain("k8s_get_pods");
    expect(tools).toContain("k8s_describe");
    expect(tools).toContain("k8s_get_events");
    expect(tools).toContain("k8s_pod_logs");
  });

  it("keeps trace tools out without service signal", () => {
    const plan = planGatherTools(baseAlert, 0);
    const tools = plan.selectedTools.map((t) => t.tool);

    expect(tools).not.toContain("query_jaeger_traces");
    expect(tools).not.toContain("get_jaeger_service_deps");
  });

  it("opens all tools on reroute", () => {
    const plan = planGatherTools(baseAlert, 1, "fetch missing dependency evidence");

    expect(plan.omittedTools).toHaveLength(0);
    expect(plan.selectedTools.map((t) => t.tool)).toContain("query_jaeger_traces");
  });
});

describe("missingRequiredPlannedTools", () => {
  it("requires Prometheus range evidence for recovered error-rate alerts", () => {
    const missing = missingRequiredPlannedTools(
      { ...baseAlert, alert_name: "ApiErrorRateRecovered", summary: "error rate recovered" },
      ["query_gcp_logs", "k8s_get_pods"],
    );

    expect(missing.map((entry) => entry.tool)).toContain("query_prom_range");
  });

  it("does not require range when already called", () => {
    const missing = missingRequiredPlannedTools(
      { ...baseAlert, alert_name: "ApiErrorRateRecovered", summary: "error rate recovered" },
      ["query_prom_range"],
    );

    expect(missing).toEqual([]);
  });

  it("requires trace and dependency tools for latency dependency alerts", () => {
    const missing = missingRequiredPlannedTools(
      { ...baseAlert, alert_name: "FrontendP99LatencyHigh", summary: "slow catalog dependency" },
      ["query_prom_range"],
    );

    expect(missing.map((entry) => entry.tool)).toEqual(["query_jaeger_traces", "get_jaeger_service_deps"]);
  });
});
