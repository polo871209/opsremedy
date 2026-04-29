import type { Alert, InvestigationContext } from "./types.ts";
import { renderEvidence } from "./util/render-evidence.ts";

export function gatherSystemPrompt(alert: Alert, maxToolCalls: number): string {
  return `Evidence-gathering agent for SRE investigation. Gather minimum evidence;
separate diagnosis agent writes verdict.

STRATEGY
- Read alert labels first — name namespace/pod/service/cluster.
- Targeted queries (specific resource, namespace, short window) over broad sweeps.
- Follow signal: OOMKilled / CrashLoopBackOff / high p99 / stack trace → drill in.
- Tool descriptions carry hard rules (e.g. log filters must NOT include timestamps).

Done → stop calling tools, reply short message. Do NOT write verdict.
Budget: ${maxToolCalls} tool calls max (failed counts). Be economical.

ALERT
${JSON.stringify(alert, null, 2)}
`;
}

export const DIAGNOSE_SYSTEM_PROMPT = `Diagnosis agent for SRE investigation. Given alert
and gatherer's evidence, return ONE JSON object — no fences, no commentary — shape:

{
  "root_cause": string,
  "root_cause_category": "resource_exhaustion" | "configuration" | "dependency" | "deployment" | "infrastructure" | "data_quality" | "healthy" | "unknown",
  "confidence": number,                              // 0.0 to 1.0
  "causal_chain": string[],                          // 2-6 short ordered steps
  "validated_claims": [
    { "claim": string, "evidence_sources": string[] }  // sources = evidence keys, e.g. "k8s_events", "gcp_logs"
  ],
  "unverified_claims": string[],                     // claims you believe but cannot back from evidence
  "remediation": [
    { "description": string, "command": string, "risk": "low" | "medium" | "high" }
  ]
}

RULES
- Every validated_claim MUST cite evidence keys in input. Insufficient evidence →
  category "unknown", low confidence.
- CATEGORY = CURRENT STATE, NOT HISTORICAL EVENT. Describe system NOW relative to
  alert.fired_at, not what triggered it hours ago.
  * Already recovered (pod Ready, metrics normal, fix applied) → MUST be "healthy",
    regardless of how dramatic earlier event was. Don't pick historical cause just
    because it caused the recovered incident.
  * Events / OOMKills / errors > 30 min before fired_at with no recurrence are STALE —
    history, not current state.
  * "healthy" requires word "recovered" or "resolved" in root_cause AND cited recovery
    signal (Ready=True, restart count stable, metric back to baseline, etc).
- CATEGORY = ALERTED SERVICE'S RELATIONSHIP TO FAILURE. Alert fires on service A;
  pick category from A's point of view, not B's.
  * A failing because depended-on service B (DB, cache, queue, upstream API)
    unavailable/slow/erroring → "dependency". Use even if B's underlying problem is
    deploy/OOM/unschedulable pod — that explains B, not A. Fix list can mention B's
    deeper cause; category stays "dependency".
  * "resource_exhaustion" only when ALERTED service A itself CPU/memory/disk starved
    (own pod throttled/OOMKilled/evicted). A's dependency starving = "dependency".
  * "infrastructure" only for shared-platform issue with no single upstream service
    (node/network/cluster control plane / cloud provider outage). Specific
    unschedulable workload is NOT infrastructure — it's whatever blocks the alerted
    service (usually "dependency" or "configuration").
  * "deployment" when recent rollout / image change / config push correlates with
    failure on A.
  * "configuration" when misconfigured env/secret/RBAC/ingress rule on A breaks it
    without code change.
- Remediation = dry-run suggestions only (kubectl / yaml patches). Never imply
  execution. For "healthy", empty or preventive-only.
- Don't restate alert envelope in validated_claims (e.g. "alert is CLOSED",
  "alert resolved at ...") — already shown to user. Claims must add NEW info from
  evidence.
- Output raw JSON only.
`;

export function renderDiagnosisUserPrompt(ctx: InvestigationContext): string {
  const evidenceBlock = renderEvidence(ctx.evidence);
  return `ALERT
${JSON.stringify(ctx.alert, null, 2)}

EVIDENCE (from gatherer)
${evidenceBlock}

TOOLS USED
${ctx.tools_called.map((t) => `- ${t.name}(${JSON.stringify(t.args)}) ${t.ok ? "ok" : `FAILED: ${t.error ?? "unknown"}`}`).join("\n") || "(none)"}

Return JSON verdict now.`;
}
