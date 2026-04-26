import type { InvestigationContext, RCAReport } from "./types.ts";

/** Hard cap on gather loops. Loop 0 is the initial pass; loop 1 is the reroute. */
export const MAX_GATHER_LOOPS = 2;
/** Confidence floor below which a reroute is considered worthwhile. */
const REROUTE_CONFIDENCE_FLOOR = 0.4;

export interface RerouteDecision {
  reroute: boolean;
  reason: string;
}

/**
 * Decide whether a second gather pass is likely to improve the verdict.
 *
 * Conservative gates:
 *   - already past the loop budget? no.
 *   - no tool-call budget left? no.
 *   - report ambiguous (`unknown` or low confidence)? yes.
 *   - otherwise? no — the LLM is already confident, don't burn another round.
 */
export function shouldReroute(report: RCAReport, ctx: InvestigationContext): RerouteDecision {
  if (ctx.loop + 1 >= MAX_GATHER_LOOPS) {
    return { reroute: false, reason: "loop budget exhausted" };
  }
  if (ctx.loop_count + ctx.inflight >= ctx.max_tool_calls) {
    return { reroute: false, reason: "tool-call budget exhausted" };
  }
  if (report.root_cause_category === "unknown") {
    return { reroute: true, reason: "category=unknown after first pass" };
  }
  if (report.confidence < REROUTE_CONFIDENCE_FLOOR) {
    return { reroute: true, reason: `confidence ${report.confidence} < ${REROUTE_CONFIDENCE_FLOOR}` };
  }
  return { reroute: false, reason: `confidence ${report.confidence} acceptable` };
}

/**
 * Build a focused hint for the next gather pass. Heuristic: look at what
 * evidence we have and what's missing relative to the unverified claims,
 * then nudge the agent toward the gap.
 *
 * Pure code, no LLM. Mirrors OpenSRE's `available_sources` mutation in
 * `node_investigate` — same "you have X, fetch Y next" idea.
 */
export function buildRerouteHint(report: RCAReport, ctx: InvestigationContext): string {
  const ev = ctx.evidence;
  const lines: string[] = [];

  // 1) Pod-level signals without supporting logs.
  const podsSeen = (ev.k8s_pods ?? []).filter((p) => !p.ready || p.lastTerminationReason !== undefined);
  if (podsSeen.length > 0 && Object.keys(ev.k8s_pod_logs ?? {}).length === 0) {
    const sample = podsSeen
      .slice(0, 2)
      .map((p) => `${p.namespace}/${p.name}`)
      .join(", ");
    lines.push(
      `You found unhealthy pods (${sample}) but have not pulled their logs yet. Use k8s_pod_logs (with previous=true if they restarted).`,
    );
  }

  // 2) Firing prom rules without the underlying metric series.
  const firing = (ev.prom_alert_rules ?? []).filter((r) => r.state === "firing");
  if (firing.length > 0 && Object.keys(ev.prom_series ?? {}).length === 0) {
    const sample = firing
      .slice(0, 2)
      .map((r) => r.name)
      .join(", ");
    lines.push(
      `Alert rules are firing (${sample}) but you have not range-queried the metric they reference. Use query_prom_range on the rule's expression.`,
    );
  }

  // 3) Errored traces without service-dependency context.
  const errored = (ev.jaeger_traces ?? []).filter((t) => t.hasError);
  if (errored.length > 0 && (ev.jaeger_service_deps ?? []).length === 0) {
    const sample = errored
      .slice(0, 2)
      .map((t) => t.rootService)
      .join(", ");
    lines.push(
      `Errored traces seen (${sample}) but no service-dependency map. Use get_jaeger_service_deps to scope upstream/downstream blast radius.`,
    );
  }

  // 4) Warning k8s events with no describe of the involved object.
  const warningEvents = (ev.k8s_events ?? []).filter((e) => e.type === "Warning");
  if (warningEvents.length > 0 && Object.keys(ev.k8s_describe ?? {}).length === 0) {
    const top = warningEvents[0];
    if (top) {
      lines.push(
        `Warning event on ${top.involvedKind}/${top.involvedName} (reason=${top.reason}). Use k8s_describe to inspect its current state.`,
      );
    }
  }

  // 5) Fall back to listing the LLM's own unverified claims as a checklist.
  if (lines.length === 0 && report.unverified_claims.length > 0) {
    const cl = report.unverified_claims.slice(0, 3).join("; ");
    lines.push(
      `The previous diagnosis flagged unverified claims: ${cl}. Pick one and gather the evidence that would confirm or rule it out.`,
    );
  }

  // 6) Last-resort generic nudge.
  if (lines.length === 0) {
    lines.push(
      `First-pass diagnosis was inconclusive (category=${report.root_cause_category}, confidence=${report.confidence}). Look at what evidence is still empty and target that next.`,
    );
  }

  return lines.join("\n");
}
