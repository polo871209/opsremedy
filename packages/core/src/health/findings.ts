/**
 * Build deterministic per-resource findings from gathered evidence.
 *
 * Adapted from k8sgpt-ai/k8sgpt analyzers (pkg/analyzer/{pod,event}.go).
 * Pure function over `Evidence`; no I/O. Runs in the pipeline regardless
 * of healthy short-circuit or diagnose path so the Lark card always has a
 * structured "what's broken" section parallel to the narrative root cause.
 */

import type { Evidence, ResourceFinding } from "../types.ts";
import { isFailureEventReason, isUnhealthyTermination, WAITING_REASON_FAILURES } from "./checks.ts";

export function deriveFindings(ev: Evidence): ResourceFinding[] {
  const out: ResourceFinding[] = [];

  for (const pod of ev.k8s_pods ?? []) {
    const finding = podFinding(pod);
    if (finding) out.push(finding);
  }

  for (const e of ev.k8s_events ?? []) {
    if (e.type !== "Warning") continue;
    if (!isFailureEventReason(e.reason)) continue;
    out.push({
      kind: e.involvedKind || "Event",
      name: e.involvedName || "(unknown)",
      namespace: e.namespace,
      text: `${e.reason}: ${e.message}`.trim(),
      severity: "warning",
      source: "deterministic",
    });
  }

  return dedupe(out);
}

function podFinding(pod: NonNullable<Evidence["k8s_pods"]>[number]): ResourceFinding | undefined {
  // Skip pods that completed successfully or are healthy.
  if (pod.phase === "Succeeded") return undefined;
  if (pod.ready && pod.phase === "Running" && !isUnhealthyTermination(pod.lastTerminationReason)) {
    return undefined;
  }

  // Prefer reporting an active waiting reason over termination history.
  const waiting =
    pod.lastTerminationReason && WAITING_REASON_FAILURES.has(pod.lastTerminationReason)
      ? pod.lastTerminationReason
      : undefined;
  const term = pod.lastTerminationReason;
  const reason = waiting ?? term;

  let text: string;
  if (reason && WAITING_REASON_FAILURES.has(reason)) {
    text = `Pod stuck: ${reason}`;
  } else if (reason && isUnhealthyTermination(reason)) {
    text = `Pod last terminated with ${reason}`;
  } else if (!pod.ready) {
    text = `Pod not ready (phase=${pod.phase})`;
  } else {
    return undefined;
  }

  if (pod.restarts > 0) text += ` · restarts=${pod.restarts}`;

  const finding: ResourceFinding = {
    kind: "Pod",
    name: pod.name,
    namespace: pod.namespace,
    text,
    severity: "critical",
    source: "deterministic",
  };
  if (pod.owner) finding.parent = pod.owner;
  return finding;
}

/**
 * Collapse duplicate (kind, name, namespace, text) tuples — events often
 * repeat across the same Pod with the same reason/message.
 */
function dedupe(findings: ResourceFinding[]): ResourceFinding[] {
  const seen = new Set<string>();
  const out: ResourceFinding[] = [];
  for (const f of findings) {
    const key = `${f.kind}|${f.namespace ?? ""}|${f.name}|${f.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
