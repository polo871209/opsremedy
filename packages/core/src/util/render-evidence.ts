import type { Evidence, LogEntry, PromSample } from "../types.ts";

/**
 * Render `Evidence` as compact JSON for the diagnoser prompt.
 * Caps payload sizes per key to keep prompts under a few thousand tokens.
 * When a list is truncated, a `_truncated` note is included so the model knows.
 */
export function renderEvidence(ev: Evidence): string {
  return JSON.stringify(compactEvidence(ev), null, 2);
}

function compactEvidence(ev: Evidence): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (ev.gcp_logs?.length) out.gcp_logs = capLogs(ev.gcp_logs, 30);
  if (ev.gcp_error_logs?.length) out.gcp_error_logs = capLogs(ev.gcp_error_logs, 30);

  if (ev.prom_instant && Object.keys(ev.prom_instant).length > 0) {
    out.prom_instant = ev.prom_instant;
  }

  if (ev.prom_series && Object.keys(ev.prom_series).length > 0) {
    const reduced: Record<string, unknown> = {};
    for (const [query, result] of Object.entries(ev.prom_series)) {
      reduced[query] = {
        series: result.series.slice(0, 5).map((s) => ({
          metric: s.metric,
          values: downsample(s.values, 30),
          ...(s.values.length > 30 && { _truncated: `${s.values.length} → 30 samples` }),
        })),
        ...(result.series.length > 5 && { _truncated_series: `${result.series.length} → 5` }),
      };
    }
    out.prom_series = reduced;
  }

  if (ev.prom_alert_rules?.length) out.prom_alert_rules = ev.prom_alert_rules;

  if (ev.jaeger_traces?.length) {
    const sorted = [...ev.jaeger_traces].sort((a, b) => b.durationMs - a.durationMs);
    out.jaeger_traces = sorted.slice(0, 20);
    if (sorted.length > 20) out._jaeger_traces_truncated = `${sorted.length} → 20`;
  }

  if (ev.jaeger_service_deps?.length) out.jaeger_service_deps = ev.jaeger_service_deps;

  if (ev.k8s_pods?.length) out.k8s_pods = ev.k8s_pods;

  if (ev.k8s_events?.length) {
    // Warnings first, then sorted by lastSeen desc.
    const sorted = [...ev.k8s_events].sort((a, b) => {
      if (a.type !== b.type) return a.type === "Warning" ? -1 : 1;
      return b.lastSeen.localeCompare(a.lastSeen);
    });
    out.k8s_events = sorted.slice(0, 30);
    if (sorted.length > 30) out._k8s_events_truncated = `${sorted.length} → 30`;
  }

  if (ev.k8s_describe && Object.keys(ev.k8s_describe).length > 0) {
    const reduced: Record<string, string> = {};
    for (const [key, text] of Object.entries(ev.k8s_describe)) {
      reduced[key] =
        text.length > 4000 ? `${text.slice(0, 4000)}\n[...truncated ${text.length - 4000} chars]` : text;
    }
    out.k8s_describe = reduced;
  }

  if (ev.k8s_pod_logs && Object.keys(ev.k8s_pod_logs).length > 0) {
    const reduced: Record<string, string[]> = {};
    for (const [key, lines] of Object.entries(ev.k8s_pod_logs)) {
      const tail = lines.slice(-100).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
      reduced[key] = tail;
      if (lines.length > 100) reduced[`${key}__truncated`] = [`${lines.length} → 100 lines`];
    }
    out.k8s_pod_logs = reduced;
  }

  if (ev.remediation_proposals?.length) out.remediation_proposals = ev.remediation_proposals;

  return out;
}

function capLogs(entries: LogEntry[], max: number): unknown {
  const slimmed = entries.slice(0, max).map((e) => ({
    timestamp: e.timestamp,
    severity: e.severity,
    textPreview: e.textPreview,
    ...(e.resource && { resource: e.resource }),
    ...(e.labels && { labels: e.labels }),
    // intentionally drop `payload` — too large for diagnoser
  }));
  if (entries.length <= max) return slimmed;
  return { entries: slimmed, _truncated: `${entries.length} → ${max}` };
}

function downsample(values: PromSample[], target: number): PromSample[] {
  if (values.length <= target) return values;
  const step = values.length / target;
  const out: PromSample[] = [];
  for (let i = 0; i < target; i++) {
    const sample = values[Math.floor(i * step)];
    if (sample) out.push(sample);
  }
  return out;
}
