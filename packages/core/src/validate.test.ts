import { describe, expect, test } from "bun:test";
import type { InvestigationContext, RCAReport } from "./types.ts";
import { ZERO_USAGE } from "./util/usage.ts";
import { coerceRCAReport, validateAndFinalize } from "./validate.ts";

function newCtx(evidence: InvestigationContext["evidence"]): InvestigationContext {
  return {
    alert: {
      alert_id: "t-1",
      alert_name: "Test",
      severity: "critical",
      fired_at: new Date().toISOString(),
      labels: {},
      annotations: {},
      summary: "",
    },
    evidence,
    tools_called: [],
    loop_count: 0,
    inflight: 0,
    max_tool_calls: 10,
    started_at: Date.now(),
    loop: 0,
    audit: [],
    plan_audit: [],
  };
}

function baseReport(over: Partial<RCAReport> = {}): RCAReport {
  return {
    alert_id: "t-1",
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

describe("coerceRCAReport", () => {
  test("parses a minimal payload", () => {
    const raw = {
      root_cause: "Memory limit exceeded",
      root_cause_category: "resource_exhaustion",
      confidence: 0.9,
      causal_chain: ["A", "B"],
      validated_claims: [{ claim: "pod OOMKilled", evidence_sources: ["k8s_events"] }],
      unverified_claims: [],
      remediation: [{ description: "raise limit", command: "kubectl edit", risk: "low" }],
    };
    const out = coerceRCAReport(raw, "t-1");
    expect(out).not.toBeNull();
    expect(out?.root_cause_category).toBe("resource_exhaustion");
    expect(out?.validated_claims.length).toBe(1);
    expect(out?.remediation[0]?.risk).toBe("low");
  });

  test("rejects missing root_cause", () => {
    expect(coerceRCAReport({}, "t-1")).toBeNull();
  });

  test("clamps confidence and normalizes category", () => {
    const out = coerceRCAReport(
      { root_cause: "x", root_cause_category: "not-a-thing", confidence: 42 },
      "t-1",
    );
    expect(out?.confidence).toBe(1);
    expect(out?.root_cause_category).toBe("unknown");
  });
});

describe("validateAndFinalize", () => {
  test("validated claim with populated evidence stays validated", () => {
    const ctx = newCtx({
      k8s_events: [
        {
          namespace: "a",
          involvedKind: "Pod",
          involvedName: "b",
          type: "Warning",
          reason: "OOMKilling",
          message: "",
          count: 1,
          lastSeen: "",
        },
      ],
    });
    const report = baseReport({
      validated_claims: [
        { claim: "pod was OOMKilled due to memory limit", evidence_sources: ["k8s_events"] },
      ],
    });
    const final = validateAndFinalize(report, ctx);
    expect(final.validated_claims.length).toBe(1);
    expect(final.unverified_claims.length).toBe(0);
    expect(final.confidence).toBe(1);
  });

  test("claim is demoted when referenced evidence is empty", () => {
    const ctx = newCtx({}); // nothing populated
    const report = baseReport({
      validated_claims: [
        { claim: "Jaeger trace shows slow downstream call", evidence_sources: ["jaeger_traces"] },
      ],
    });
    const final = validateAndFinalize(report, ctx);
    expect(final.validated_claims.length).toBe(0);
    expect(final.unverified_claims).toContain("Jaeger trace shows slow downstream call");
    expect(final.confidence).toBe(0);
  });

  test("claim is demoted when evidence text does not support it", () => {
    const ctx = newCtx({
      jaeger_traces: [
        {
          traceId: "t1",
          rootService: "api",
          rootOperation: "GET /orders",
          durationMs: 100,
          hasError: true,
          spanCount: 5,
          noteworthySpan: "auth-service returned 503",
        },
      ],
    });
    const report = baseReport({
      validated_claims: [
        { claim: "database timeout caused slow checkout", evidence_sources: ["jaeger_traces"] },
      ],
    });

    const final = validateAndFinalize(report, ctx);

    expect(final.validated_claims).toHaveLength(0);
    expect(final.unverified_claims).toContain("database timeout caused slow checkout");
  });

  test("healthy verdict without recovery language is confidence capped against bad evidence", () => {
    const ctx = newCtx({
      gcp_error_logs: [{ timestamp: "now", severity: "ERROR", textPreview: "payment failed" }],
    });
    const report = baseReport({
      root_cause_category: "healthy",
      root_cause: "service is fine",
      validated_claims: [{ claim: "payment failed", evidence_sources: ["gcp_error_logs"] }],
    });

    const final = validateAndFinalize(report, ctx);

    expect(final.confidence).toBe(0.4);
    expect(final.unverified_claims.join(" ")).toMatch(/conflicts/);
  });

  test("adds evidence provenance from audit entries", () => {
    const ctx = newCtx({
      gcp_logs: [{ timestamp: "now", severity: "ERROR", textPreview: "boom" }],
    });
    ctx.audit.push({
      loop: 0,
      tool: "query_gcp_logs",
      args: { filter: "severity>=ERROR" },
      startedAt: 1,
      durationMs: 2,
      ok: true,
      summary: "Fetched 1 log entry",
      evidenceKeys: ["gcp_logs"],
    });
    const report = baseReport({
      validated_claims: [{ claim: "boom error", evidence_sources: ["gcp_logs"] }],
    });

    const final = validateAndFinalize(report, ctx);

    expect(final.evidence_provenance?.gcp_logs?.[0]?.tool).toBe("query_gcp_logs");
  });
});
