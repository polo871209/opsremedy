import { describe, expect, test } from "bun:test";
import type { Alert, RCAReport } from "@opsremedy/core/types";
import { ZERO_USAGE } from "@opsremedy/core/types";
import { buildRcaCard, CARD_TARGET_BYTES } from "./card.ts";
import { jsonByteSize } from "./truncate.ts";

const ALERT: Alert = {
  alert_id: "alert-42",
  alert_name: "PaymentsP99HighLatency",
  severity: "critical",
  fired_at: "2025-04-01T10:00:00Z",
  labels: { service: "payments" },
  annotations: {},
  summary: "p99 above 2s for 5 minutes",
};

function rep(over: Partial<RCAReport> = {}): RCAReport {
  return {
    alert_id: ALERT.alert_id,
    root_cause: "Postgres connection pool saturated; checkout calls queueing.",
    root_cause_category: "resource_exhaustion",
    confidence: 0.82,
    causal_chain: [
      "Traffic spike at 10:00 UTC raised RPS by 3x",
      "Pool size of 20 insufficient under new load",
      "Connection acquisition latency dominates request latency",
    ],
    validated_claims: [
      { claim: "pg_stat_activity shows 20 active connections", evidence_sources: ["prom_instant"] },
      { claim: "Checkout p99 grew from 200ms to 2.4s", evidence_sources: ["prom_series"] },
    ],
    unverified_claims: ["No deploys correlated with the spike"],
    remediation: [
      {
        description: "Increase pgbouncer pool to 50",
        risk: "low",
        command: "kubectl -n payments set env deploy/pgbouncer POOL_SIZE=50",
      },
    ],
    tools_called: ["query_prom_instant", "query_prom_series", "k8s_pods"],
    duration_ms: 12345,
    usage: { ...ZERO_USAGE, total_tokens: 5000, cost_usd: 0.042 },
    ...over,
  };
}

describe("buildRcaCard", () => {
  test("non-healthy → red header", () => {
    const c = buildRcaCard(rep(), ALERT);
    expect(c.header.template).toBe("red");
    expect(c.header.title.content).toBe("[critical] PaymentsP99HighLatency");
  });

  test("healthy → green header", () => {
    const c = buildRcaCard(rep({ root_cause_category: "healthy" }), ALERT);
    expect(c.header.template).toBe("green");
  });

  test("unknown → grey header", () => {
    const c = buildRcaCard(rep({ root_cause_category: "unknown" }), ALERT);
    expect(c.header.template).toBe("grey");
  });

  test("contains expected sections", () => {
    const c = buildRcaCard(rep(), ALERT);
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).toContain("**Category:**");
    expect(md).toContain("**Confidence:** 82%");
    expect(md).not.toContain("Cost");
    expect(md).toContain("**Root cause**");
    expect(md).toContain("**Causal chain**");
    expect(md).toContain("**Validated claims**");
    expect(md).toContain("**Unverified claims**");
    expect(md).toContain("**Remediation");
    expect(md).not.toContain("alert_id");
  });

  test("no remediation/unverified → those sections omitted", () => {
    const c = buildRcaCard(rep({ remediation: [], unverified_claims: [] }), ALERT);
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).not.toContain("Remediation");
    expect(md).not.toContain("Unverified claims");
  });

  test("alertUrl produces an action button", () => {
    const c = buildRcaCard(rep(), ALERT, { alertUrl: "https://example.com/a/1" });
    const action = c.elements.find((e) => e.tag === "action");
    expect(action).toBeDefined();
    if (action && action.tag === "action") {
      expect(action.actions[0]?.url).toBe("https://example.com/a/1");
    }
  });

  test("absent alertUrl → no action button", () => {
    const c = buildRcaCard(rep(), ALERT);
    expect(c.elements.find((e) => e.tag === "action")).toBeUndefined();
  });

  test("findings render with parent label and namespace", () => {
    const c = buildRcaCard(
      rep({
        findings: [
          {
            kind: "Pod",
            name: "payments-api-abc",
            namespace: "payments",
            parent: "Deployment/payments-api",
            text: "Pod stuck: CrashLoopBackOff · restarts=14",
            severity: "critical",
            source: "deterministic",
          },
        ],
      }),
      ALERT,
    );
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).toContain("**Findings**");
    expect(md).toContain("**Deployment/payments-api**");
    expect(md).toContain("ns: payments");
    expect(md).toContain("CrashLoopBackOff");
  });

  test("missing findings → section omitted", () => {
    const c = buildRcaCard(rep(), ALERT);
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).not.toContain("**Findings**");
  });

  test("evidence links produce inline markdown links for matching sources", () => {
    const c = buildRcaCard(rep(), ALERT, {
      evidenceLinks: {
        prom_instant: "https://prom.example.com/graph?g0.expr=up",
        prom_series: "https://prom.example.com/graph?g0.expr=rate",
      },
    });
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).toContain("[prom_instant](https://prom.example.com/graph?g0.expr=up)");
    expect(md).toContain("[prom_series](https://prom.example.com/graph?g0.expr=rate)");
  });

  test("URL parens are percent-encoded so markdown link parser doesn't break", () => {
    const c = buildRcaCard(rep(), ALERT, {
      evidenceLinks: {
        prom_instant: "http://localhost:9090/graph?g0.expr=sum(rate(foo[5m]))",
      },
    });
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    // The URL inside the prom_instant link must have its ( and ) encoded.
    expect(md).toContain("[prom_instant](http://localhost:9090/graph?g0.expr=sum%28rate%28foo[5m]%29%29)");
  });

  test("sources without a link entry render as plain text", () => {
    const c = buildRcaCard(
      rep({
        validated_claims: [{ claim: "k8s evidence", evidence_sources: ["k8s_pods"] }],
      }),
      ALERT,
      { evidenceLinks: {} },
    );
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).toContain("k8s_pods");
    expect(md).not.toContain("](");
  });

  test("oversized report stays under target", () => {
    const huge = "x".repeat(50_000);
    const r = rep({
      root_cause: huge,
      causal_chain: Array.from({ length: 50 }, (_, i) => `${i}: ${huge}`),
      validated_claims: Array.from({ length: 30 }, (_, i) => ({
        claim: `claim ${i}: ${huge}`,
        evidence_sources: ["a", "b", "c"],
      })),
      unverified_claims: Array.from({ length: 30 }, () => huge),
      remediation: Array.from({ length: 10 }, () => ({
        description: huge,
        risk: "high" as const,
        command: huge,
      })),
    });
    const c = buildRcaCard(r, ALERT);
    expect(jsonByteSize(c)).toBeLessThanOrEqual(CARD_TARGET_BYTES);
  });

  test("empty causal chain renders gracefully", () => {
    const c = buildRcaCard(rep({ causal_chain: [] }), ALERT);
    const md = c.elements.map((e) => (e.tag === "markdown" ? e.content : "")).join("\n");
    expect(md).toContain("**Causal chain**");
    expect(md).toContain("_(none)_");
  });
});
