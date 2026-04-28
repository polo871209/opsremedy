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

  uiUrl(filter: string, errorsOnly = false): string {
    // GCP Console Logs Explorer uses a matrix parameter `;query=...` BEFORE
    // the `?project=...` query string. Putting `;query` after the project
    // makes the console parse the filter as part of the project name and
    // returns "Invalid resource requested: projects/<project>;query=...".
    const projectQs = `?project=${encodeURIComponent(this.projectId)}`;
    const parts = filter ? [filter] : [];
    if (errorsOnly && !/severity\s*[>=<]/i.test(filter)) parts.push("severity>=ERROR");
    if (parts.length === 0) {
      return `https://console.cloud.google.com/logs/query${projectQs}`;
    }
    const matrix = `;query=${encodeURIComponent(parts.join("\n"))}`;
    return `https://console.cloud.google.com/logs/query${matrix}${projectQs}`;
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
    (m.jsonPayload && typeof (m.jsonPayload as Record<string, unknown>).message === "string"
      ? ((m.jsonPayload as Record<string, unknown>).message as string)
      : null) ||
    (raw.data && typeof raw.data === "string" ? raw.data : null) ||
    "";

  return {
    timestamp,
    severity,
    textPreview: collapseToOneLine(textFromPayload),
    ...(m.jsonPayload && { payload: m.jsonPayload as Record<string, unknown> }),
    ...(Object.keys(resourceLabels).length > 0 && { resource: resourceLabels }),
    ...(Object.keys(labels).length > 0 && { labels }),
  };
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
