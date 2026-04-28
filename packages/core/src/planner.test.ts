import { describe, expect, it } from "bun:test";
import { planGatherTools } from "./planner.ts";
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

    expect(tools).not.toContain("jaeger_find_traces");
    expect(tools).not.toContain("jaeger_service_dependencies");
  });

  it("opens all tools on reroute", () => {
    const plan = planGatherTools(baseAlert, 1, "fetch missing dependency evidence");

    expect(plan.omittedTools).toHaveLength(0);
    expect(plan.selectedTools.map((t) => t.tool)).toContain("jaeger_find_traces");
  });
});
