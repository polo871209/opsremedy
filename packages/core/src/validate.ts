import {
  ALL_EVIDENCE_KEYS,
  type Evidence,
  type EvidenceKey,
  type InvestigationContext,
  type RCAReport,
  type RemediationProposal,
  type RootCauseCategory,
  type ValidatedClaim,
  ZERO_USAGE,
} from "./types.ts";

// ---------------- constants ----------------

const CATEGORIES: RootCauseCategory[] = [
  "resource_exhaustion",
  "configuration",
  "dependency",
  "deployment",
  "infrastructure",
  "data_quality",
  "healthy",
  "unknown",
];

/**
 * When a validated claim mentions any keyword in `keywords`, we require at
 * least one of the listed `required` evidence keys to be populated. This
 * stops the LLM from claiming "OOMKilled" without ever fetching k8s state.
 *
 * Kept intentionally small. Add a row when a benchmark scenario reveals a
 * gap; over-fitting hurts precision.
 */
const KEYWORD_EVIDENCE_MAP: Array<{ keywords: RegExp; required: EvidenceKey[] }> = [
  { keywords: /\b(oom|oomkilled|memory)\b/i, required: ["k8s_events", "k8s_describe", "k8s_pods"] },
  { keywords: /\b(crashloop|crashloopbackoff|restart)\b/i, required: ["k8s_events", "k8s_pods"] },
  { keywords: /\b(latency|p99|slow|timeout)\b/i, required: ["prom_series", "prom_instant", "jaeger_traces"] },
  { keywords: /\b(error log|stack trace|exception)\b/i, required: ["gcp_logs", "gcp_error_logs"] },
  { keywords: /\b(log|logs)\b/i, required: ["gcp_logs", "gcp_error_logs", "k8s_pod_logs"] },
  { keywords: /\b(pod|container|kubernetes|k8s)\b/i, required: ["k8s_pods", "k8s_describe", "k8s_events"] },
  { keywords: /\b(event)\b/i, required: ["k8s_events"] },
  { keywords: /\b(trace|span|service dependency)\b/i, required: ["jaeger_traces", "jaeger_service_deps"] },
  { keywords: /\b(cpu|throttl|saturation|utilization)\b/i, required: ["prom_series", "prom_instant"] },
  { keywords: /\b(alert rule|recording rule|firing)\b/i, required: ["prom_alert_rules"] },
  { keywords: /\b(config|environment variable|env var|flag)\b/i, required: ["k8s_describe", "gcp_logs"] },
];

// ---------------- coercion helpers ----------------

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asCategory(v: unknown): RootCauseCategory {
  return CATEGORIES.includes(v as RootCauseCategory) ? (v as RootCauseCategory) : "unknown";
}

function asConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : 0;
  return Math.max(0, Math.min(1, n));
}

function asRisk(v: unknown): "low" | "medium" | "high" {
  return v === "low" || v === "medium" || v === "high" ? v : "medium";
}

function asValidatedClaim(v: unknown): ValidatedClaim | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const claim = asString(obj.claim);
  if (!claim) return null;
  return { claim, evidence_sources: asStringArray(obj.evidence_sources) };
}

function asRemediation(v: unknown): RemediationProposal | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const description = asString(obj.description);
  if (!description) return null;
  const command = asString(obj.command);
  return {
    description,
    risk: asRisk(obj.risk),
    ...(command !== null && { command }),
  };
}

// ---------------- claim verification ----------------

function evidenceKeyPopulated(ev: Evidence, key: EvidenceKey): boolean {
  const v = ev[key];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * Decide whether the collected evidence actually backs a claim.
 *
 * Two checks, both must pass:
 *   1. If the claim declares `evidence_sources` that map to known evidence
 *      keys, at least one of those keys must be populated. (Claims that
 *      cite only unknown source names skip this check.)
 *   2. For every keyword group whose pattern matches the claim text, at
 *      least one of the mapped evidence keys must be populated.
 */
function isClaimBacked(claim: ValidatedClaim, ev: Evidence): boolean {
  const declared = claim.evidence_sources.filter((s): s is EvidenceKey =>
    (ALL_EVIDENCE_KEYS as readonly string[]).includes(s),
  );
  if (declared.length > 0 && !declared.some((k) => evidenceKeyPopulated(ev, k))) {
    return false;
  }

  for (const { keywords, required } of KEYWORD_EVIDENCE_MAP) {
    if (!keywords.test(claim.claim)) continue;
    if (!required.some((k) => evidenceKeyPopulated(ev, k))) return false;
  }
  return true;
}

// ---------------- public api ----------------

/** Shape guard for the raw LLM JSON payload. Does NOT revalidate claims. */
export function coerceRCAReport(raw: unknown, alertId: string): RCAReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const rootCause = asString(r.root_cause);
  if (!rootCause) return null;

  return {
    alert_id: alertId,
    root_cause: rootCause,
    root_cause_category: asCategory(r.root_cause_category),
    confidence: asConfidence(r.confidence),
    causal_chain: asStringArray(r.causal_chain),
    validated_claims: Array.isArray(r.validated_claims)
      ? r.validated_claims.map(asValidatedClaim).filter((c): c is ValidatedClaim => c !== null)
      : [],
    unverified_claims: asStringArray(r.unverified_claims),
    remediation: Array.isArray(r.remediation)
      ? r.remediation.map(asRemediation).filter((r): r is RemediationProposal => r !== null)
      : [],
    tools_called: [],
    duration_ms: 0,
    usage: { ...ZERO_USAGE },
  };
}

/**
 * Code-level pass over the LLM's report:
 *  - demote any claim whose evidence isn't actually present to `unverified`
 *  - recompute confidence as backed / total claims
 *  - stamp the real `tools_called` and `duration_ms` from the context
 */
export function validateAndFinalize(report: RCAReport, ctx: InvestigationContext): RCAReport {
  const validated: ValidatedClaim[] = [];
  const unverified: string[] = [...report.unverified_claims];

  for (const claim of report.validated_claims) {
    if (isClaimBacked(claim, ctx.evidence)) {
      validated.push(claim);
    } else {
      unverified.push(claim.claim);
    }
  }

  const total = validated.length + unverified.length;
  const confidence = total > 0 ? validated.length / total : 0;

  return {
    ...report,
    validated_claims: validated,
    unverified_claims: unverified,
    confidence: Math.round(confidence * 100) / 100,
    tools_called: ctx.tools_called.map((t) => t.name),
    duration_ms: Date.now() - ctx.started_at,
  };
}
