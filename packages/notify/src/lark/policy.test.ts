import { describe, expect, test } from "bun:test";
import type { RCAReport, RootCauseCategory } from "@opsremedy/core/types";
import { ZERO_USAGE } from "@opsremedy/core/types";
import type { LarkConfig } from "../types.ts";
import { shouldSend } from "./policy.ts";

function rep(over: Partial<RCAReport> = {}): RCAReport {
  return {
    alert_id: "a1",
    root_cause: "x",
    root_cause_category: "deployment",
    confidence: 0.8,
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

const CFG: LarkConfig = {
  enabled: true,
  domain: "lark",
  appId: "cli_x",
  appSecret: "s",
  receiveIdType: "chat_id",
  receiveId: "oc_x",
  locale: "en_US",
  sendOn: "non_healthy",
  lowConfidenceThreshold: 0.5,
};

const NON_HEALTHY: RootCauseCategory[] = [
  "resource_exhaustion",
  "configuration",
  "dependency",
  "deployment",
  "infrastructure",
  "data_quality",
  "unknown",
];

describe("shouldSend", () => {
  test("always sends regardless of category", () => {
    for (const c of [...NON_HEALTHY, "healthy" as const]) {
      expect(shouldSend(rep({ root_cause_category: c }), "always", CFG)).toBe(true);
    }
  });

  test("non_healthy skips healthy and sends others", () => {
    expect(shouldSend(rep({ root_cause_category: "healthy" }), "non_healthy", CFG)).toBe(false);
    for (const c of NON_HEALTHY) {
      expect(shouldSend(rep({ root_cause_category: c }), "non_healthy", CFG)).toBe(true);
    }
  });

  test("low_confidence: skips healthy", () => {
    expect(shouldSend(rep({ root_cause_category: "healthy", confidence: 0.1 }), "low_confidence", CFG)).toBe(
      false,
    );
  });

  test("low_confidence: sends only when below threshold for non-healthy", () => {
    expect(
      shouldSend(rep({ root_cause_category: "deployment", confidence: 0.49 }), "low_confidence", CFG),
    ).toBe(true);
    expect(
      shouldSend(rep({ root_cause_category: "deployment", confidence: 0.5 }), "low_confidence", CFG),
    ).toBe(false);
    expect(
      shouldSend(rep({ root_cause_category: "deployment", confidence: 0.9 }), "low_confidence", CFG),
    ).toBe(false);
  });
});
