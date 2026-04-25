import type { Evidence, RCAReport } from "@opsremedy/core/types";
import type { ScenarioAnswer } from "./load.ts";

export interface ScenarioScore {
  category_ok: boolean;
  keywords_ok: boolean;
  not_forbidden: boolean;
  evidence_ok: boolean;
  trajectory_ok: boolean;
  loops_ok: boolean;
  overall: boolean;
  missing_keywords: string[];
  missing_evidence: string[];
  missing_trajectory: string[];
  hit_forbidden_keywords: string[];
}

function textBlob(report: RCAReport): string {
  return [report.root_cause, ...report.causal_chain, ...report.validated_claims.map((c) => c.claim)]
    .join(" ")
    .toLowerCase();
}

function keyPopulated(ev: Evidence, key: string): boolean {
  const v = ev[key];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function scoreScenario(
  report: RCAReport,
  evidence: Evidence,
  toolsCalled: string[],
  answer: ScenarioAnswer,
): ScenarioScore {
  const text = textBlob(report);

  const category_ok = report.root_cause_category === answer.expected_category;

  const missing_keywords = (answer.required_keywords ?? []).filter((k) => !text.includes(k.toLowerCase()));
  const keywords_ok = missing_keywords.length === 0;

  const hit_forbidden_keywords = (answer.forbidden_keywords ?? []).filter((k) =>
    text.includes(k.toLowerCase()),
  );
  const forbidden_categories = answer.forbidden_categories ?? [];
  const not_forbidden =
    !forbidden_categories.includes(report.root_cause_category) && hit_forbidden_keywords.length === 0;

  const missing_evidence = (answer.required_evidence_sources ?? []).filter(
    (key) => !keyPopulated(evidence, key),
  );
  const evidence_ok = missing_evidence.length === 0;

  const missing_trajectory = (answer.optimal_trajectory ?? []).filter((t) => !toolsCalled.includes(t));
  const trajectory_ok = missing_trajectory.length === 0;

  const loops_ok = toolsCalled.length <= answer.max_tool_calls;

  const overall = category_ok && keywords_ok && not_forbidden && evidence_ok && trajectory_ok && loops_ok;

  return {
    category_ok,
    keywords_ok,
    not_forbidden,
    evidence_ok,
    trajectory_ok,
    loops_ok,
    overall,
    missing_keywords,
    missing_evidence,
    missing_trajectory,
    hit_forbidden_keywords,
  };
}
