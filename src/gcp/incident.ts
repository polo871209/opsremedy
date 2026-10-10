// Top-level fields snake_case; some nested fields camelCase (metric.displayName,
// documentation.links[].displayName). We accept both casings for link fields.

import type { Alert } from "../alert.ts";

export interface GCPWebhookPayload {
  version: string;
  incident: Incident;
}

export interface Incident {
  incident_id: string;
  scoping_project_id?: string;
  scoping_project_number?: number;
  url?: string;
  state: "open" | "closed" | string;
  severity?: string;
  started_at?: number;
  ended_at?: number;
  summary?: string;
  policy_name: string;
  policy_user_labels?: Record<string, string>;
  condition_name?: string;
  threshold_value?: string;
  observed_value?: string;
  resource_id?: string;
  resource_name?: string;
  resource_display_name?: string;
  resource_type_display_name?: string;
  resource?: { type?: string; labels?: Record<string, string> };
  metric?: { type?: string; displayName?: string; labels?: Record<string, string> };
  metadata?: { system_labels?: Record<string, string>; user_labels?: Record<string, string> };
  documentation?: {
    content?: string;
    mime_type?: string;
    subject?: string;
    // GCP webhook empirically ships PascalCase (`DisplayName`, `URL`) despite
    // docs claiming camelCase. The REST AlertPolicy schema uses camelCase
    // (`displayName`, `url`). Accept all three casings to be safe.
    links?: { DisplayName?: string; displayName?: string; display_name?: string; URL?: string; url?: string }[];
  };
}

const SUBJECT_LABELS: { key: string; display: string }[] = [
  { key: "destination_service_name", display: "Service" },
  { key: "service_name", display: "Service" },
  { key: "container_name", display: "Service" },
  { key: "container", display: "Service" },
  { key: "function_name", display: "Function" },
  { key: "database_id", display: "Database" },
  { key: "consumergroup", display: "Consumer Group" },
  { key: "queue_id", display: "Queue" },
  { key: "instance_name", display: "Instance" },
  { key: "topic", display: "Topic" },
  { key: "pod", display: "Pod" },
  { key: "deployment", display: "Deployment" },
];

export function findSubject(inc: Incident): { key: string; display: string; value: string } | undefined {
  const pools: (Record<string, string> | undefined)[] = [
    inc.metric?.labels,
    inc.resource?.labels,
    inc.metadata?.system_labels,
    inc.metadata?.user_labels,
  ];
  for (const lbl of SUBJECT_LABELS) {
    for (const pool of pools) {
      const v = pool?.[lbl.key];
      if (v) return { key: lbl.key, display: lbl.display, value: v };
    }
  }
  return undefined;
}

// Logs Explorer: matrix `;startTime=`/`;endTime=` (omit endTime → renders "Now").
// Grafana: from/to epoch-ms query params (literal "now" when open).
const LOGS_START_RE = /;startTime=[^;?]*/;
const LOGS_END_RE = /;endTime=[^;?]*/;
const LOGS_TIMERANGE_RE = /;timeRange=[^;?]*/;

export function rewriteLinkTimeRange(rawURL: string, startedAt?: number, endedAt?: number): string {
  if (!rawURL || !startedAt || startedAt <= 0) return rawURL;
  const startMs = (startedAt - 30 * 60) * 1000;
  const endMs = endedAt && endedAt > 0 ? endedAt * 1000 : undefined;
  const startISO = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const endISO = endMs ? new Date(endMs).toISOString().replace(/\.\d{3}Z$/, ".000Z") : undefined;

  if (rawURL.includes("/logs/query")) {
    // No endTime → Logs Explorer renders "<start> — Now". Closed alert writes endTime to freeze.
    let out = rawURL.replace(LOGS_TIMERANGE_RE, "").replace(LOGS_START_RE, "").replace(LOGS_END_RE, "");
    const matrix = `;startTime=${startISO}` + (endISO ? `;endTime=${endISO}` : "");
    const q = out.indexOf("?");
    return q >= 0 ? out.slice(0, q) + matrix + out.slice(q) : out + matrix;
  }

  try {
    const u = new URL(rawURL);
    if (u.host.includes("grafana.")) {
      u.searchParams.set("from", String(startMs));
      u.searchParams.set("to", endMs ? String(endMs) : "now");
      return u.toString();
    }
  } catch {}
  return rawURL;
}

// Stable identity of the *alerting condition*, independent of incident_id.
// GCP re-issues incident_id every time it closes and re-opens a policy, and a
// PromQL policy can do that within minutes while the condition never went
// false (observed on "Kafka Consumer Lag High": three ids in 11 minutes, lag
// pinned above the threshold the whole time). Keyed on the labels instead, the
// same underlying problem maps to one key across all those ids.
export function alertKey(inc: Incident): string {
  const labels: string[] = [];
  for (const pool of [inc.metric?.labels, inc.resource?.labels]) {
    for (const [k, v] of Object.entries(pool ?? {})) labels.push(`${k}=${v}`);
  }
  labels.sort();
  const h = new Bun.CryptoHasher("sha256");
  h.update(
    [inc.scoping_project_id ?? "", inc.condition_name ?? "", inc.resource?.type ?? "", ...labels].join("\u0000"),
  );
  return `${inc.policy_name}|${h.digest("hex").slice(0, 16)}`;
}

export function incidentToAlert(inc: Incident): Alert {
  const subj = findSubject(inc);
  return {
    name: inc.policy_name,
    source: "gcp-monitoring",
    severity: inc.severity || "warning",
    service: subj?.value,
    message: inc.summary,
    startedAt: inc.started_at ? new Date(inc.started_at * 1000).toISOString() : new Date().toISOString(),
    endedAt: inc.ended_at ? new Date(inc.ended_at * 1000).toISOString() : undefined,
    labels: {
      ...(inc.policy_user_labels ?? {}),
      ...(inc.metadata?.user_labels ?? {}),
      incident_id: inc.incident_id,
      condition: inc.condition_name ?? "",
      project: inc.scoping_project_id ?? "",
    },
  };
}
