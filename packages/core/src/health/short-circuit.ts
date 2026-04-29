import type { Alert, Evidence, RCAReport, ValidatedClaim } from "../types.ts";
import { ZERO_USAGE } from "../types.ts";
import { ERROR_LOG_SEVERITIES, UNHEALTHY_CONTAINER_REASONS } from "./checks.ts";

export interface HealthVerdict {
  healthy: boolean;
  /** Short reason text included in the deterministic report. */
  reason: string;
}

/**
 * Decide whether the alert + collected evidence indicate a clearly healthy
 * state — i.e. no signals of a real problem right now. When true, the caller
 * skips the diagnose LLM call and emits a deterministic `category: "healthy"`
 * report.
 *
 * Deliberately conservative: any error-level log, firing rule, errored span,
 * or unhealthy pod state flips the verdict to not-healthy. Designed to be
 * a strict subset of what diagnose() would also call healthy, so enabling
 * the short-circuit can never produce a worse verdict than the LLM.
 *
 * Mirrors OpenSRE `is_clearly_healthy` (see app/nodes/root_cause_diagnosis/
 * evidence_checker.py) but adapted to opsremedy's evidence shape.
 */
export function isClearlyHealthy(alert: Alert, ev: Evidence): HealthVerdict {
  const sev = alert.severity.toLowerCase();
  const titleHealthy = /\b(health|heartbeat|verify|verification|recovered|resolved)\b/i.test(
    `${alert.alert_name} ${alert.summary}`,
  );
  const sevHealthy = sev === "info";
  if (!sevHealthy && !titleHealthy) {
    return { healthy: false, reason: "alert is not informational/health-style" };
  }

  if ((ev.gcp_logs ?? []).some((e) => ERROR_LOG_SEVERITIES.has(e.severity))) {
    return { healthy: false, reason: "gcp_logs contain ERROR-or-higher entries" };
  }
  if ((ev.gcp_error_logs ?? []).length > 0) {
    return { healthy: false, reason: "gcp_error_logs is non-empty" };
  }

  if ((ev.prom_alert_rules ?? []).some((r) => r.state === "firing")) {
    return { healthy: false, reason: "prom_alert_rules contain a firing rule" };
  }

  if ((ev.jaeger_traces ?? []).some((t) => t.hasError)) {
    return { healthy: false, reason: "jaeger_traces contain errored spans" };
  }

  if (
    (ev.k8s_pods ?? []).some(
      (p) =>
        (!p.ready && p.phase !== "Succeeded") ||
        (p.lastTerminationReason !== undefined && UNHEALTHY_CONTAINER_REASONS.has(p.lastTerminationReason)),
    )
  ) {
    return { healthy: false, reason: "k8s_pods contain not-ready or unhealthy-terminated pods" };
  }

  if ((ev.k8s_events ?? []).some((e) => e.type === "Warning")) {
    return { healthy: false, reason: "k8s_events contain Warning entries" };
  }

  return { healthy: true, reason: "no error logs, firing rules, errored spans, or unhealthy pods" };
}

/**
 * Build a deterministic RCAReport for the healthy short-circuit. One claim
 * per non-empty evidence source so the report visibly cites what was
 * checked. `usage` is zeroed because no LLM ran for diagnose.
 */
export function buildHealthyReport(alert: Alert, ev: Evidence, reason: string): RCAReport {
  const validated: ValidatedClaim[] = [];
  const sources: Array<keyof Evidence> = [
    "gcp_logs",
    "gcp_error_logs",
    "prom_instant",
    "prom_series",
    "prom_alert_rules",
    "jaeger_traces",
    "jaeger_service_deps",
    "k8s_pods",
    "k8s_events",
    "k8s_describe",
    "k8s_pod_logs",
  ];
  for (const key of sources) {
    if (!evidencePopulated(ev, key)) continue;
    validated.push({
      claim: `${key} confirmed within healthy bounds`,
      evidence_sources: [key as string],
    });
  }

  return {
    alert_id: alert.alert_id,
    root_cause: `${alert.alert_name}: signals recovered/nominal — ${reason}.`,
    root_cause_category: "healthy",
    confidence: 1,
    causal_chain: [
      `Alert ${alert.alert_name} fired (severity=${alert.severity}).`,
      "Evidence gather found no error-level signals across logs, metrics, traces, or k8s state.",
      "System is currently healthy; no remediation required.",
    ],
    validated_claims: validated,
    unverified_claims: [],
    remediation: [],
    tools_called: [],
    duration_ms: 0,
    usage: { ...ZERO_USAGE },
  };
}

function evidencePopulated(ev: Evidence, key: keyof Evidence): boolean {
  const v = ev[key];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}
