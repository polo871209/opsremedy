import { describe, expect, test } from "bun:test";
import type { Alert, Evidence } from "../types.ts";
import { buildHealthyReport, isClearlyHealthy } from "./short-circuit.ts";

const baseAlert: Alert = {
  alert_id: "h-1",
  alert_name: "HealthCheck",
  severity: "info",
  fired_at: new Date().toISOString(),
  labels: {},
  annotations: {},
  summary: "Heartbeat verification",
};

describe("isClearlyHealthy", () => {
  test("info severity + empty evidence = healthy", () => {
    expect(isClearlyHealthy(baseAlert, {}).healthy).toBe(true);
  });

  test("non-info severity without health-keyword title = not healthy", () => {
    const a: Alert = { ...baseAlert, severity: "critical", alert_name: "PodDown", summary: "" };
    expect(isClearlyHealthy(a, {}).healthy).toBe(false);
  });

  test("critical severity but title says recovered = healthy", () => {
    const a: Alert = {
      ...baseAlert,
      severity: "critical",
      alert_name: "HighCPUUsage",
      summary: "service recovered, CPU back to baseline",
    };
    expect(isClearlyHealthy(a, {}).healthy).toBe(true);
  });

  test("ERROR-level gcp_logs flips to not healthy", () => {
    const ev: Evidence = {
      gcp_logs: [{ timestamp: "now", severity: "ERROR", textPreview: "boom" }],
    };
    const v = isClearlyHealthy(baseAlert, ev);
    expect(v.healthy).toBe(false);
    expect(v.reason).toMatch(/gcp_logs/);
  });

  test("INFO-only gcp_logs stay healthy", () => {
    const ev: Evidence = {
      gcp_logs: [{ timestamp: "now", severity: "INFO", textPreview: "ok" }],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(true);
  });

  test("firing prom rule flips to not healthy", () => {
    const ev: Evidence = {
      prom_alert_rules: [{ name: "X", state: "firing", query: "", labels: {} }],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(false);
  });

  test("inactive prom rules stay healthy", () => {
    const ev: Evidence = {
      prom_alert_rules: [{ name: "X", state: "inactive", query: "", labels: {} }],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(true);
  });

  test("errored jaeger trace flips to not healthy", () => {
    const ev: Evidence = {
      jaeger_traces: [
        {
          traceId: "t",
          rootService: "svc",
          rootOperation: "op",
          durationMs: 10,
          hasError: true,
          spanCount: 1,
        },
      ],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(false);
  });

  test("CrashLoopBackOff pod termination flips to not healthy", () => {
    const ev: Evidence = {
      k8s_pods: [
        {
          namespace: "ns",
          name: "p",
          phase: "Running",
          ready: true,
          restarts: 5,
          lastTerminationReason: "CrashLoopBackOff",
        },
      ],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(false);
  });

  test("not-ready pod flips to not healthy", () => {
    const ev: Evidence = {
      k8s_pods: [{ namespace: "ns", name: "p", phase: "Pending", ready: false, restarts: 0 }],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(false);
  });

  test("Warning k8s event flips to not healthy", () => {
    const ev: Evidence = {
      k8s_events: [
        {
          namespace: "ns",
          involvedKind: "Pod",
          involvedName: "p",
          type: "Warning",
          reason: "BackOff",
          message: "x",
          count: 1,
          lastSeen: "2026-01-01",
        },
      ],
    };
    expect(isClearlyHealthy(baseAlert, ev).healthy).toBe(false);
  });
});

describe("buildHealthyReport", () => {
  test("emits one claim per populated evidence source", () => {
    const ev: Evidence = {
      gcp_logs: [{ timestamp: "n", severity: "INFO", textPreview: "ok" }],
      prom_series: { "rate(x)": { series: [] } },
    };
    const r = buildHealthyReport(baseAlert, ev, "no errors");
    expect(r.root_cause_category).toBe("healthy");
    expect(r.confidence).toBe(1);
    const cited = r.validated_claims.flatMap((c) => c.evidence_sources);
    expect(cited).toContain("gcp_logs");
    expect(cited).toContain("prom_series");
  });

  test("empty evidence still produces a healthy report with no claims", () => {
    const r = buildHealthyReport(baseAlert, {}, "no signals");
    expect(r.root_cause_category).toBe("healthy");
    expect(r.validated_claims).toHaveLength(0);
  });
});
