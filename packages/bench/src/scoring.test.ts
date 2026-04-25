import { describe, expect, test } from "bun:test";
import { ZERO_USAGE } from "@opsremedy/core";
import type { Evidence, RCAReport } from "@opsremedy/core/types";
import type { ScenarioAnswer } from "./load.ts";
import { scoreScenario } from "./scoring.ts";

function rep(over: Partial<RCAReport> = {}): RCAReport {
  return {
    alert_id: "a-1",
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

function ans(over: Partial<ScenarioAnswer> = {}): ScenarioAnswer {
  return {
    scenario_id: "test",
    difficulty: 1,
    expected_category: "resource_exhaustion",
    required_keywords: [],
    required_evidence_sources: [],
    max_tool_calls: 10,
    ...over,
  };
}

describe("scoreScenario", () => {
  test("all green when category, keywords, evidence, trajectory match", () => {
    const out = scoreScenario(
      rep({
        root_cause_category: "resource_exhaustion",
        root_cause: "OOMKilled due to memory pressure",
      }),
      { k8s_events: [{} as never] } as Evidence,
      ["k8s_get_events"],
      ans({
        required_keywords: ["OOMKilled", "memory"],
        required_evidence_sources: ["k8s_events"],
        optimal_trajectory: ["k8s_get_events"],
      }),
    );
    expect(out.overall).toBe(true);
  });

  test("category mismatch fails", () => {
    const out = scoreScenario(
      rep({ root_cause_category: "configuration" }),
      {},
      [],
      ans({ expected_category: "resource_exhaustion" }),
    );
    expect(out.category_ok).toBe(false);
    expect(out.overall).toBe(false);
  });

  test("missing required keyword reported", () => {
    const out = scoreScenario(
      rep({ root_cause: "pod crashed" }),
      {},
      [],
      ans({ required_keywords: ["OOMKilled", "memory"], expected_category: "unknown" }),
    );
    expect(out.missing_keywords).toContain("OOMKilled");
    expect(out.missing_keywords).toContain("memory");
  });

  test("forbidden category triggers not_forbidden=false", () => {
    const out = scoreScenario(
      rep({ root_cause_category: "healthy" }),
      {},
      [],
      ans({ expected_category: "healthy", forbidden_categories: ["healthy"] }),
    );
    expect(out.not_forbidden).toBe(false);
  });

  test("forbidden keyword in claim text fails", () => {
    const out = scoreScenario(
      rep({
        root_cause: "system is fine",
        validated_claims: [{ claim: "the cpu was saturated", evidence_sources: [] }],
      }),
      {},
      [],
      ans({ forbidden_keywords: ["cpu was saturated"] }),
    );
    expect(out.hit_forbidden_keywords).toContain("cpu was saturated");
    expect(out.not_forbidden).toBe(false);
  });

  test("numeric YAML keywords coerced to string (regression for 503)", () => {
    const out = scoreScenario(
      rep({ root_cause: "got status 503 from upstream" }),
      {},
      [],
      ans({ required_keywords: [503 as unknown as string] }),
    );
    expect(out.keywords_ok).toBe(true);
  });

  test("loops_ok=false when too many tool calls", () => {
    const out = scoreScenario(rep(), {}, ["a", "b", "c", "d"], ans({ max_tool_calls: 3 }));
    expect(out.loops_ok).toBe(false);
  });

  test("missing evidence reported", () => {
    const out = scoreScenario(rep(), {}, [], ans({ required_evidence_sources: ["k8s_events"] }));
    expect(out.missing_evidence).toContain("k8s_events");
  });

  test("empty array evidence treated as missing", () => {
    const out = scoreScenario(
      rep(),
      { k8s_events: [] } as Evidence,
      [],
      ans({ required_evidence_sources: ["k8s_events"] }),
    );
    expect(out.evidence_ok).toBe(false);
  });
});
