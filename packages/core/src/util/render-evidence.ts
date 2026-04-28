import type { Evidence, LogEntry, PromSample } from "../types.ts";

const LOG_LIMIT = 30;
const PROM_SERIES_LIMIT = 5;
const PROM_SAMPLE_LIMIT = 30;
const TRACE_LIMIT = 20;
const EVENT_LIMIT = 30;
const DESCRIBE_CHAR_LIMIT = 4000;
const POD_LOG_LINE_LIMIT = 100;
const POD_LOG_CHAR_LIMIT = 200;

export function renderEvidence(ev: Evidence): string {
  return JSON.stringify(compactEvidence(ev), null, 2);
}

function compactEvidence(ev: Evidence): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (ev.gcp_logs?.length) out.gcp_logs = capLogs(ev.gcp_logs, LOG_LIMIT);
  if (ev.gcp_error_logs?.length) out.gcp_error_logs = capLogs(ev.gcp_error_logs, LOG_LIMIT);

  if (ev.prom_instant && Object.keys(ev.prom_instant).length > 0) {
    out.prom_instant = ev.prom_instant;
  }

  if (ev.prom_series && Object.keys(ev.prom_series).length > 0) {
    const reduced: Record<string, unknown> = {};
    for (const [query, result] of Object.entries(ev.prom_series)) {
      reduced[query] = {
        series: result.series.slice(0, PROM_SERIES_LIMIT).map((s) => ({
          metric: s.metric,
          values: downsample(s.values, PROM_SAMPLE_LIMIT),
          ...(s.values.length > PROM_SAMPLE_LIMIT && {
            _truncated: `${s.values.length} → ${PROM_SAMPLE_LIMIT} samples`,
          }),
        })),
        ...(result.series.length > PROM_SERIES_LIMIT && {
          _truncated_series: `${result.series.length} → ${PROM_SERIES_LIMIT}`,
        }),
      };
    }
    out.prom_series = reduced;
  }

  if (ev.prom_alert_rules?.length) out.prom_alert_rules = ev.prom_alert_rules;

  if (ev.jaeger_traces?.length) {
    const sorted = [...ev.jaeger_traces].sort((a, b) => b.durationMs - a.durationMs);
    out.jaeger_traces = sorted.slice(0, TRACE_LIMIT);
    if (sorted.length > TRACE_LIMIT) out._jaeger_traces_truncated = `${sorted.length} → ${TRACE_LIMIT}`;
  }

  if (ev.jaeger_service_deps?.length) out.jaeger_service_deps = ev.jaeger_service_deps;

  if (ev.k8s_pods?.length) out.k8s_pods = ev.k8s_pods;

  if (ev.k8s_events?.length) {
    const sorted = [...ev.k8s_events].sort((a, b) => {
      if (a.type !== b.type) return a.type === "Warning" ? -1 : 1;
      return b.lastSeen.localeCompare(a.lastSeen);
    });
    out.k8s_events = sorted.slice(0, EVENT_LIMIT);
    if (sorted.length > EVENT_LIMIT) out._k8s_events_truncated = `${sorted.length} → ${EVENT_LIMIT}`;
  }

  if (ev.k8s_describe && Object.keys(ev.k8s_describe).length > 0) {
    const reduced: Record<string, string> = {};
    for (const [key, text] of Object.entries(ev.k8s_describe)) {
      reduced[key] =
        text.length > DESCRIBE_CHAR_LIMIT
          ? `${text.slice(0, DESCRIBE_CHAR_LIMIT)}\n[...truncated ${text.length - DESCRIBE_CHAR_LIMIT} chars]`
          : text;
    }
    out.k8s_describe = reduced;
  }

  if (ev.k8s_pod_logs && Object.keys(ev.k8s_pod_logs).length > 0) {
    const reduced: Record<string, string[]> = {};
    for (const [key, lines] of Object.entries(ev.k8s_pod_logs)) {
      const tail = lines
        .slice(-POD_LOG_LINE_LIMIT)
        .map((line) => (line.length > POD_LOG_CHAR_LIMIT ? `${line.slice(0, POD_LOG_CHAR_LIMIT)}…` : line));
      reduced[key] = tail;
      if (lines.length > POD_LOG_LINE_LIMIT) {
        reduced[`${key}__truncated`] = [`${lines.length} → ${POD_LOG_LINE_LIMIT} lines`];
      }
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
