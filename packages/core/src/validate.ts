import {
  ALL_EVIDENCE_KEYS,
  type Evidence,
  type EvidenceKey,
  type InvestigationContext,
  type RCAReport,
  type RemediationProposal,
  type RootCauseCategory,
  type ValidatedClaim,
} from "./types.ts";

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

/** Shape guard for the raw LLM JSON payload. Does NOT revalidate claims. */
export function coerceRCAReport(raw: unknown, alertId: string): RCAReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const rootCause = typeof r.root_cause === "string" ? r.root_cause : "";
  if (!rootCause) return null;

  const category = CATEGORIES.includes(r.root_cause_category as RootCauseCategory)
    ? (r.root_cause_category as RootCauseCategory)
    : "unknown";

  const rawConfidence = typeof r.confidence === "number" ? r.confidence : 0;
  const confidence = Math.max(0, Math.min(1, rawConfidence));

  const causalChain = Array.isArray(r.causal_chain)
    ? (r.causal_chain as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const validatedClaims: ValidatedClaim[] = Array.isArray(r.validated_claims)
    ? (r.validated_claims as unknown[])
        .map((c) => {
          if (!c || typeof c !== "object") return null;
          const obj = c as Record<string, unknown>;
          const claim = typeof obj.claim === "string" ? obj.claim : null;
          if (!claim) return null;
          const sources = Array.isArray(obj.evidence_sources)
            ? (obj.evidence_sources as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
          return { claim, evidence_sources: sources };
        })
        .filter((c): c is ValidatedClaim => c !== null)
    : [];

  const unverifiedClaims = Array.isArray(r.unverified_claims)
    ? (r.unverified_claims as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const remediation: RemediationProposal[] = Array.isArray(r.remediation)
    ? (r.remediation as unknown[])
        .map((rem) => {
          if (!rem || typeof rem !== "object") return null;
          const obj = rem as Record<string, unknown>;
          const description = typeof obj.description === "string" ? obj.description : null;
          if (!description) return null;
          const risk =
            obj.risk === "low" || obj.risk === "medium" || obj.risk === "high" ? obj.risk : "medium";
          const command = typeof obj.command === "string" ? obj.command : undefined;
          return { description, risk, ...(command !== undefined && { command }) };
        })
        .filter((r): r is RemediationProposal => r !== null)
    : [];

  return {
    alert_id: alertId,
    root_cause: rootCause,
    root_cause_category: category,
    confidence,
    causal_chain: causalChain,
    validated_claims: validatedClaims,
    unverified_claims: unverifiedClaims,
    remediation,
    tools_called: [],
    duration_ms: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    },
  };
}

/**
 * Keyword→evidence-key map. When a claim mentions these words, we require at least
 * one of the mapped evidence keys to be non-empty in ctx.evidence.
 * Intentionally small; expand as scenarios expose gaps.
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

function evidenceKeyPopulated(ev: Evidence, key: EvidenceKey): boolean {
  const v = ev[key];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * For a single claim, decide whether the evidence dict actually backs it.
 * A claim is considered backed if ALL of:
 *   1. At least one declared `evidence_sources` key is populated in ctx.evidence.
 *   2. For every keyword group that matches the claim text, at least one of the
 *      mapped evidence keys is populated.
 */
function isClaimBacked(claim: ValidatedClaim, ev: Evidence): boolean {
  const declared = claim.evidence_sources.filter((s): s is EvidenceKey =>
    (ALL_EVIDENCE_KEYS as readonly string[]).includes(s),
  );
  if (declared.length > 0 && !declared.some((k) => evidenceKeyPopulated(ev, k))) {
    return false;
  }
  // Nothing declared? Fall through to keyword check.

  for (const { keywords, required } of KEYWORD_EVIDENCE_MAP) {
    if (!keywords.test(claim.claim)) continue;
    if (!required.some((k) => evidenceKeyPopulated(ev, k))) return false;
  }
  return true;
}

/** Rewrite the RCA report based on code-level checks against collected evidence. */
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
