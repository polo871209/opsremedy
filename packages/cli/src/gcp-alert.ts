import type { Alert } from "@opsremedy/core";
import { GoogleAuth } from "google-auth-library";

/**
 * Parse a GCP Monitoring console URL to extract project + alert/policy id.
 *
 * Supported shapes:
 *   https://console.cloud.google.com/monitoring/alerting/alerts/<incident_id>?project=<project>
 *   https://console.cloud.google.com/monitoring/alerting/policies/<policy_id>?project=<project>
 *   https://console.cloud.google.com/monitoring/alerting/incidents/<incident_id>?project=<project>
 */
export interface ParsedUrl {
  projectId: string;
  kind: "incident" | "policy";
  id: string;
  raw: string;
}

export function parseGcpAlertUrl(url: string): ParsedUrl {
  const u = new URL(url);
  const project = u.searchParams.get("project");
  if (!project) throw new Error(`Missing ?project= in URL: ${url}`);

  // Path looks like /monitoring/alerting/{alerts|policies|incidents}/<id>
  const segs = u.pathname.split("/").filter(Boolean);
  const idx = segs.indexOf("alerting");
  if (idx === -1 || idx + 2 >= segs.length) {
    throw new Error(`Unsupported GCP Monitoring URL path: ${u.pathname}`);
  }
  const subtype = segs[idx + 1];
  const id = segs[idx + 2];
  if (!id) throw new Error(`Missing alert/policy id in URL path: ${u.pathname}`);

  let kind: ParsedUrl["kind"];
  if (subtype === "alerts" || subtype === "incidents") kind = "incident";
  else if (subtype === "policies") kind = "policy";
  else throw new Error(`Unknown URL segment '${subtype}' (expected alerts/incidents/policies)`);

  return { projectId: project, kind, id, raw: url };
}

// ---------------- API fetch ----------------

interface IncidentResponse {
  name?: string;
  state?: string;
  // GCP returns camelCase via REST despite docs showing snake_case.
  openTime?: string;
  closeTime?: string;
  open_time?: string;
  close_time?: string;
  resource?: { type?: string; labels?: Record<string, string> };
  metric?: { type?: string; labels?: Record<string, string> };
  policy?: { name?: string; displayName?: string };
  summaryText?: string;
}

interface AlertPolicyResponse {
  name?: string;
  displayName?: string;
  documentation?: { content?: string; mimeType?: string };
  conditions?: Array<{
    displayName?: string;
    conditionThreshold?: { filter?: string };
    conditionMatchedLog?: { filter?: string };
  }>;
  enabled?: boolean;
  userLabels?: Record<string, string>;
  combiner?: string;
}

const MONITORING_BASE = "https://monitoring.googleapis.com/v3";

/**
 * Fetch alert info from GCP. Tries the incidents API first; if 404/403/etc,
 * falls back to the AlertPolicy API. Throws if both fail or ADC missing.
 */
export async function fetchAlertFromGcp(parsed: ParsedUrl): Promise<Alert> {
  const token = await getAccessToken();

  if (parsed.kind === "incident") {
    const incident = await tryFetchIncident(parsed.projectId, parsed.id, token);
    if (incident) return incidentToAlert(incident, parsed);
    // Incident API unavailable — try the policy that's referenced (we don't know it yet)
    // so just fall through to a stub if user pasted an incident URL.
    throw new Error(
      `Could not fetch incident ${parsed.id} via Cloud Monitoring API.\n` +
        `The /alerts endpoint is in Public Preview and may not be enabled for project ${parsed.projectId}.\n` +
        `Tip: paste an alertPolicy URL instead: https://console.cloud.google.com/monitoring/alerting/policies/<id>?project=${parsed.projectId}`,
    );
  }

  // policy
  const policy = await fetchPolicy(parsed.projectId, parsed.id, token);
  return policyToAlert(policy, parsed);
}

async function tryFetchIncident(
  projectId: string,
  incidentId: string,
  token: string,
): Promise<IncidentResponse | null> {
  const url = `${MONITORING_BASE}/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(incidentId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": projectId,
      Accept: "application/json",
    },
  });
  if (res.status === 404 || res.status === 403 || res.status === 501) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloud Monitoring incidents API ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as IncidentResponse;
}

async function fetchPolicy(projectId: string, policyId: string, token: string): Promise<AlertPolicyResponse> {
  const url = `${MONITORING_BASE}/projects/${encodeURIComponent(projectId)}/alertPolicies/${encodeURIComponent(policyId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": projectId,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloud Monitoring alertPolicies API ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as AlertPolicyResponse;
}

// ---------------- mapping ----------------

function incidentToAlert(inc: IncidentResponse, parsed: ParsedUrl): Alert {
  const resourceLabels = inc.resource?.labels ?? {};
  const metricLabels = inc.metric?.labels ?? {};
  const labels = mergeLabels(resourceLabels, metricLabels, { project_id: parsed.projectId });

  const severity = inferSeverity(inc.policy?.displayName ?? "");

  return {
    alert_id: inc.name?.split("/").pop() ?? parsed.id,
    alert_name: inc.policy?.displayName ?? "GCP Monitoring Incident",
    severity,
    fired_at: inc.openTime ?? inc.open_time ?? new Date().toISOString(),
    labels,
    annotations: {
      ...(inc.policy?.name && { policy_name: inc.policy.name }),
      ...(inc.metric?.type && { metric_type: inc.metric.type }),
      ...(inc.resource?.type && { resource_type: inc.resource.type }),
      ...(inc.state && { state: inc.state }),
      ...((inc.closeTime ?? inc.close_time) && { closed_at: (inc.closeTime ?? inc.close_time) as string }),
      source_url: parsed.raw,
    },
    summary: inc.summaryText ?? `GCP incident on ${inc.resource?.type ?? "resource"}`,
    raw: inc,
  };
}

function policyToAlert(policy: AlertPolicyResponse, parsed: ParsedUrl): Alert {
  const condition = policy.conditions?.[0];
  const filter = condition?.conditionThreshold?.filter ?? condition?.conditionMatchedLog?.filter ?? "";
  const inferredLabels = parseFilterLabels(filter);
  const labels = mergeLabels(inferredLabels, policy.userLabels ?? {}, { project_id: parsed.projectId });

  return {
    alert_id: policy.name?.split("/").pop() ?? parsed.id,
    alert_name: policy.displayName ?? "GCP Alert Policy",
    severity: inferSeverity(policy.displayName ?? ""),
    fired_at: new Date().toISOString(),
    labels,
    annotations: {
      ...(policy.name && { policy_name: policy.name }),
      ...(condition?.displayName && { condition_name: condition.displayName }),
      ...(filter && { condition_filter: filter }),
      ...(policy.documentation?.content && { documentation: policy.documentation.content }),
      source_url: parsed.raw,
    },
    summary: policy.documentation?.content?.slice(0, 200) ?? policy.displayName ?? "GCP alert policy",
    raw: policy,
  };
}

/**
 * Pull standard k8s/service labels out of resource + metric label bags.
 * Maps GCP names to the labels our agent's prompts and tools expect.
 */
function mergeLabels(...sources: Array<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of sources) {
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined || value === "") continue;
      out[key] = value;
    }
  }
  // Normalize common GCP label names → our shape.
  alias(out, "namespace_name", "namespace");
  alias(out, "pod_name", "pod");
  alias(out, "container_name", "container");
  alias(out, "cluster_name", "cluster");
  return out;
}

function alias(out: Record<string, string>, gcpName: string, ours: string): void {
  if (out[gcpName] && !out[ours]) out[ours] = out[gcpName] as string;
}

/** Best-effort filter parser to extract `resource.labels.foo="bar"` pairs. */
function parseFilterLabels(filter: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:resource|metric)\.labels?\.(\w+)\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((m = re.exec(filter)) !== null) {
    const key = m[1];
    const val = m[2];
    if (key && val) out[key] = val;
  }
  return out;
}

function inferSeverity(name: string): Alert["severity"] {
  const n = name.toLowerCase();
  if (n.includes("critical") || n.includes("p0") || n.includes("p1")) return "critical";
  if (n.includes("warn") || n.includes("p2")) return "warning";
  return "info";
}

// ---------------- ADC token ----------------

let cachedAuth: GoogleAuth | null = null;

async function getAccessToken(): Promise<string> {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: [
        "https://www.googleapis.com/auth/monitoring.read",
        "https://www.googleapis.com/auth/cloud-platform",
      ],
    });
  }
  try {
    const client = await cachedAuth.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp?.token) {
      throw new Error("empty access token");
    }
    return tokenResp.token;
  } catch (err) {
    throw new Error(
      `Failed to get GCP access token: ${(err as Error).message}\n` +
        `Run: gcloud auth application-default login\n` +
        `(then re-run opsremedy)`,
    );
  }
}
