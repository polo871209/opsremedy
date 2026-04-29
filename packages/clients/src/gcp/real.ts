import { Logging } from "@google-cloud/logging";
import type { LogEntry } from "@opsremedy/core/types";
import type { GcpLoggingClient, GcpLogsQuery } from "../types.ts";

/**
 * Real GCP Cloud Logging client. Auth via Application Default Credentials.
 * Combines the caller's filter with a timestamp range.
 */
export class RealGcpLoggingClient implements GcpLoggingClient {
  private readonly logging: Logging;

  constructor(private readonly projectId: string) {
    this.logging = new Logging({ projectId });
  }

  async search(q: GcpLogsQuery): Promise<LogEntry[]> {
    const tsFilter = `timestamp >= "${q.from.toISOString()}" AND timestamp <= "${q.to.toISOString()}"`;
    const filter = q.filter ? `${q.filter} AND ${tsFilter}` : tsFilter;
    // `getEntries` does not accept AbortSignal; the signal is honored only for client-level cancellation.
    void q.signal;

    const [entries] = await this.logging.getEntries({
      filter,
      // `maxResults` caps total entries; do NOT also set `pageSize` — gax warns
      // (AutopaginateTrueWarning) when both are set without autoPaginate=false.
      maxResults: q.max,
      orderBy: "timestamp desc",
      resourceNames: [`projects/${this.projectId}`],
    });
    return entries.map((e) => toLogEntry(e as unknown as RawEntry));
  }

  uiUrl(filter: string, errorsOnly = false, window?: { from: Date; to: Date }): string {
    // GCP Console Logs Explorer uses matrix parameters (`;query=...;timeRange=...`)
    // BEFORE the `?project=...` query string. Putting them after the project
    // makes the console parse them as part of the project name and returns
    // "Invalid resource requested: projects/<project>;query=...".
    //
    // Time encoding: we anchor on the window end via `cursorTimestamp` and
    // express the span as ISO 8601 duration `PT<minutes>M`. This is the form
    // the Console emits itself and survives copy/paste reliably across
    // tenants. (`timeRange=<from>/<to>` is also accepted but is sometimes
    // rewritten by the UI on first load.)
    const projectQs = `?project=${encodeURIComponent(this.projectId)}`;
    const parts = filter ? [filter] : [];
    if (errorsOnly && !/severity\s*[>=<]/i.test(filter)) parts.push("severity>=ERROR");
    const matrix: string[] = [];
    if (parts.length > 0) matrix.push(`query=${encodeURIComponent(parts.join("\n"))}`);
    if (window) {
      const durationMin = Math.max(1, Math.ceil((window.to.getTime() - window.from.getTime()) / 60_000));
      matrix.push(`cursorTimestamp=${encodeURIComponent(window.to.toISOString())}`);
      matrix.push(`duration=PT${durationMin}M`);
    }
    const matrixStr = matrix.length > 0 ? `;${matrix.join(";")}` : "";
    return `https://console.cloud.google.com/logs/query${matrixStr}${projectQs}`;
  }
}

interface RawEntry {
  metadata?: {
    timestamp?: { seconds?: number | string; nanos?: number } | Date | string | null;
    severity?: string | number | null;
    resource?: { type?: string; labels?: Record<string, string> } | null;
    labels?: Record<string, string> | null;
    textPayload?: string | null;
    jsonPayload?: Record<string, unknown> | null;
    httpRequest?: unknown;
  };
  data?: unknown;
}

const SEVERITY_NAMES: Record<number, string> = {
  0: "DEFAULT",
  100: "DEBUG",
  200: "INFO",
  300: "NOTICE",
  400: "WARNING",
  500: "ERROR",
  600: "CRITICAL",
  700: "ALERT",
  800: "EMERGENCY",
};

function toLogEntry(raw: RawEntry): LogEntry {
  const m = raw.metadata ?? {};
  const timestamp = renderTimestamp(m.timestamp);
  const severity = renderSeverity(m.severity);
  const resourceLabels = m.resource?.labels ?? {};
  const labels = m.labels ?? {};

  const textFromPayload =
    (typeof m.textPayload === "string" && m.textPayload) ||
    (m.jsonPayload ? renderJsonPayload(m.jsonPayload as Record<string, unknown>) : null) ||
    (raw.data && typeof raw.data === "string" ? raw.data : null) ||
    "";

  return {
    timestamp,
    severity,
    textPreview: collapseToOneLine(textFromPayload),
    ...(m.jsonPayload && { payload: m.jsonPayload as Record<string, unknown> }),
    ...(m.resource?.type && { resourceType: m.resource.type }),
    ...(Object.keys(resourceLabels).length > 0 && { resource: resourceLabels }),
    ...(Object.keys(labels).length > 0 && { labels }),
  };
}

/**
 * Render a structured jsonPayload to a single readable line. Tries common
 * message fields first, then falls back to a compact key=value summary so
 * istio/envoy access logs (which have no `message` field) still produce
 * useful previews for the LLM.
 *
 * Exported for unit tests; not part of the GcpLoggingClient interface.
 */
export function renderJsonPayload(payload: Record<string, unknown>): string {
  for (const key of MESSAGE_KEYS) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Envoy/istio access-log shape: response_code + path + cluster + flags.
  const accessLog = renderAccessLog(payload);
  if (accessLog) return accessLog;
  // Generic fallback: short compact JSON of the leaf scalars.
  return compactScalars(payload);
}

const MESSAGE_KEYS = ["message", "msg", "error", "err", "reason", "description", "summary", "log"];

function renderAccessLog(p: Record<string, unknown>): string {
  const code = p.response_code ?? p.responseCode ?? p.status ?? p.statusCode;
  if (code === undefined) return "";
  const parts: string[] = [`status=${code}`];
  const flags = p.response_flags ?? p.responseFlags;
  if (typeof flags === "string" && flags) parts.push(`flags=${flags}`);
  const method = p.method;
  if (typeof method === "string") parts.push(`method=${method}`);
  const path = p.path ?? p.request_path;
  if (typeof path === "string") parts.push(`path=${path}`);
  const upstream = p.upstream_cluster ?? p.upstreamCluster ?? p.upstream_host ?? p.upstreamHost;
  if (typeof upstream === "string") parts.push(`upstream=${upstream}`);
  const dur = p.duration ?? p.upstream_service_time;
  if (typeof dur === "number" || typeof dur === "string") parts.push(`dur=${dur}ms`);
  return parts.join(" ");
}

function compactScalars(payload: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (out.length >= 8) break;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      if (s.length > 0) out.push(`${k}=${s.length > 80 ? `${s.slice(0, 77)}...` : s}`);
    }
  }
  return out.join(" ");
}

function renderTimestamp(ts: unknown): string {
  if (!ts) return new Date(0).toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "string") return ts;
  if (typeof ts === "object" && ts !== null && "seconds" in ts) {
    const obj = ts as { seconds?: number | string; nanos?: number };
    const seconds = Number(obj.seconds ?? 0);
    const ms = seconds * 1000 + Math.floor((obj.nanos ?? 0) / 1_000_000);
    return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

function renderSeverity(sev: unknown): string {
  if (typeof sev === "string") return sev.toUpperCase();
  if (typeof sev === "number") return SEVERITY_NAMES[sev] ?? "DEFAULT";
  return "DEFAULT";
}

function collapseToOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
