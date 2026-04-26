import { describe, expect, test } from "bun:test";
import { buildRerouteHint, MAX_GATHER_LOOPS, shouldReroute } from "./reroute.ts";
import { newContext } from "./run.ts";
import type { Alert, RCAReport } from "./types.ts";
import { ZERO_USAGE } from "./util/usage.ts";

const ALERT: Alert = {
  alert_id: "r-1",
  alert_name: "ServiceDegraded",
  severity: "warning",
  fired_at: new Date().toISOString(),
  labels: { namespace: "ns", pod: "p1" },
  annotations: {},
  summary: "",
};

function rep(over: Partial<RCAReport> = {}): RCAReport {
  return {
    alert_id: ALERT.alert_id,
    root_cause: "stub",
    root_cause_category: "unknown",
    confidence: 0,
    causal_chain: [],
    validated_claims: [],
    unverified_claims: [],
    remediation: [],
    tools_called: [],
    duration_ms: 0,
    usage: ZERO_USAGE,
    ...over,
  };
}

describe("shouldReroute", () => {
  test("category=unknown with budget left → reroute", () => {
    const ctx = newContext(ALERT, 10);
    ctx.loop = 0;
    ctx.loop_count = 3;
    const d = shouldReroute(rep({ root_cause_category: "unknown", confidence: 0.5 }), ctx);
    expect(d.reroute).toBe(true);
  });

  test("low confidence with budget left → reroute", () => {
    const ctx = newContext(ALERT, 10);
    ctx.loop = 0;
    ctx.loop_count = 3;
    const d = shouldReroute(rep({ root_cause_category: "configuration", confidence: 0.2 }), ctx);
    expect(d.reroute).toBe(true);
  });

  test("high confidence with named category → no reroute", () => {
    const ctx = newContext(ALERT, 10);
    ctx.loop = 0;
    const d = shouldReroute(rep({ root_cause_category: "resource_exhaustion", confidence: 0.9 }), ctx);
    expect(d.reroute).toBe(false);
  });

  test("loop budget exhausted → no reroute even when ambiguous", () => {
    const ctx = newContext(ALERT, 10);
    ctx.loop = MAX_GATHER_LOOPS - 1;
    const d = shouldReroute(rep({ root_cause_category: "unknown" }), ctx);
    expect(d.reroute).toBe(false);
    expect(d.reason).toMatch(/loop budget/);
  });

  test("tool-call budget exhausted → no reroute", () => {
    const ctx = newContext(ALERT, 5);
    ctx.loop = 0;
    ctx.loop_count = 5;
    const d = shouldReroute(rep({ root_cause_category: "unknown" }), ctx);
    expect(d.reroute).toBe(false);
    expect(d.reason).toMatch(/tool-call budget/);
  });
});

describe("buildRerouteHint", () => {
  test("flags pods seen without logs", () => {
    const ctx = newContext(ALERT, 10);
    ctx.evidence.k8s_pods = [{ namespace: "ns", name: "p1", phase: "Running", ready: false, restarts: 3 }];
    const hint = buildRerouteHint(rep(), ctx);
    expect(hint).toMatch(/k8s_pod_logs/);
    expect(hint).toMatch(/ns\/p1/);
  });

  test("flags firing rules without metric series", () => {
    const ctx = newContext(ALERT, 10);
    ctx.evidence.prom_alert_rules = [{ name: "HighCpu", state: "firing", query: "x", labels: {} }];
    const hint = buildRerouteHint(rep(), ctx);
    expect(hint).toMatch(/query_prom_range/i);
    expect(hint).toMatch(/HighCpu/);
  });

  test("flags errored traces without dep map", () => {
    const ctx = newContext(ALERT, 10);
    ctx.evidence.jaeger_traces = [
      {
        traceId: "t",
        rootService: "checkout",
        rootOperation: "POST /buy",
        durationMs: 10,
        hasError: true,
        spanCount: 5,
      },
    ];
    const hint = buildRerouteHint(rep(), ctx);
    expect(hint).toMatch(/get_jaeger_service_deps/);
    expect(hint).toMatch(/checkout/);
  });

  test("falls back to unverified_claims when no structural gap", () => {
    const ctx = newContext(ALERT, 10);
    const hint = buildRerouteHint(
      rep({ unverified_claims: ["pod was OOMKilled", "memory limits too low"] }),
      ctx,
    );
    expect(hint).toMatch(/OOMKilled/);
  });

  test("last-resort generic nudge when nothing else fits", () => {
    const ctx = newContext(ALERT, 10);
    const hint = buildRerouteHint(rep({ root_cause_category: "unknown", confidence: 0 }), ctx);
    expect(hint.length).toBeGreaterThan(0);
  });
});
