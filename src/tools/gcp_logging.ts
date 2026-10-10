import { Type } from "@earendil-works/pi-ai";
import type { SreTool } from "./types.ts";
import { Logging, type Entry } from "@google-cloud/logging";
import { guarded, textResult } from "./result.ts";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function logsExplorerUrl(project: string, filter: string, startISO: string, endISO: string): string {
  const q = encodeURIComponent(filter);
  return `https://console.cloud.google.com/logs/query;query=${q};startTime=${startISO};endTime=${endISO}?project=${project}`;
}

let _client: Logging | undefined;
function client(project: string): Logging {
  if (!_client) _client = new Logging({ projectId: project });
  return _client;
}

// Envoy access log shape, as set by the mesh accessLogFormat.
// `response_flags` is the reliable marker: it is envoy-only and, unlike httpRequest,
// stays in the payload (see envoyField).
function isEnvoyAccess(p: Record<string, unknown> | undefined): boolean {
  if (!p) return false;
  return typeof p === "object" && "response_flags" in p;
}

// The GKE logging agent lifts GCP "special JSON fields" out of the payload onto the
// LogEntry: accessLogFormat's httpRequest, labels and trace land at the top level,
// while non-proto leftovers stay behind (jsonPayload.httpRequest keeps requestId and
// referer, which the HttpRequest proto has no room for). So an envoy field must be
// read from both places, top level first.
function envoyField(m: Record<string, unknown>, p: Record<string, unknown>, key: string): unknown {
  const top = (m.httpRequest ?? {}) as Record<string, unknown>;
  const left = (p.httpRequest ?? {}) as Record<string, unknown>;
  return top[key] ?? left[key];
}

const PATH_ID_RE = /\b(?:[0-9a-f]{8,}|[0-9]{2,}|[0-9a-f]{4,}-[0-9a-f-]+)\b/gi;
function templatize(path: string | undefined): string {
  if (!path) return "";
  const q = path.indexOf("?");
  const base = q >= 0 ? path.slice(0, q) : path;
  return base.replace(PATH_ID_RE, ":id");
}

// Structured app logs set `logging.googleapis.com/trace` + `.../spanId` in the payload; the GKE
// logging agent promotes those to the LogEntry's top-level `trace` / `spanId` fields
// (https://docs.cloud.google.com/logging/docs/structured-logging — special JSON fields).
// Check metadata first, fall back to payload. trace value is `projects/<proj>/traces/<id>`;
// return the bare id for jaeger_get_trace plus the spanId to pinpoint the exact span.
// trace_sampled tells whether spans reached Jaeger: an app can stamp a trace id on EVERY request
// but only sampled ones export spans. Asymmetric signal, measured on
// prod: true is reliable, false is not — the proto3 default makes "never set" (Envoy access
// logs, services predating the mixin) indistinguishable from "explicitly unsampled", and those
// traces are usually in Jaeger anyway. So false only demotes an id, it never blocks a lookup.
function extractTrace(
  meta: Record<string, unknown>,
  payload?: Record<string, unknown>,
): { traceId: string | null; spanId: string | null; sampled?: boolean } {
  const rawTrace =
    (meta.trace as string | undefined) ?? (payload?.["logging.googleapis.com/trace"] as string | undefined);
  const traceId = rawTrace ? (rawTrace.split("/").pop() ?? null) : null;
  const spanId =
    (meta.spanId as string | undefined) ?? (payload?.["logging.googleapis.com/spanId"] as string | undefined) ?? null;
  const rawSampled =
    (meta.traceSampled as boolean | undefined) ??
    (payload?.["logging.googleapis.com/trace_sampled"] as boolean | undefined);
  return { traceId, spanId, sampled: typeof rawSampled === "boolean" ? rawSampled : undefined };
}

function appSignature(
  payload: Record<string, unknown> | undefined,
  fallback: string,
): { message: string; errorCode?: string; errorName?: string } {
  const errObj = (payload?.error ?? payload?.err) as Record<string, unknown> | undefined;
  let errorCode: string | undefined;
  let errorName: string | undefined;
  if (errObj && typeof errObj === "object" && !Array.isArray(errObj)) {
    if (errObj.code != null && errObj.code !== "") errorCode = String(errObj.code);
    if (typeof errObj.name === "string") errorName = errObj.name;
  }
  const rawMsg = payload?.message;
  const errMsg = errObj?.message;
  const message =
    typeof rawMsg === "string" && rawMsg
      ? rawMsg.slice(0, 160)
      : typeof errMsg === "string"
        ? errMsg.slice(0, 160)
        : undefined;
  return { message: message || fallback.slice(0, 80), errorCode, errorName };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

interface EnvoyRowIn {
  ts?: string;
  p: Record<string, unknown>;
  m: Record<string, unknown>;
}
interface EnvoyAgg {
  authority: string;
  method: string;
  path: string;
  status_class: string;
  flags: string;
  count: number;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  upstream_clusters: string[];
  sample_trace: string | null;
  sample_trace_sampled?: boolean;
  sample_request_id: string | null;
  firstTs?: string;
  lastTs?: string;
}

function aggregateEnvoy(rows: EnvoyRowIn[]): EnvoyAgg[] {
  const groups = new Map<string, EnvoyAgg & { durations: number[] }>();
  for (const r of rows) {
    const p = r.p;
    const labels = (r.m.labels ?? p["logging.googleapis.com/labels"] ?? {}) as Record<string, string>;
    const authority = labels.authority ?? "";
    const method = (envoyField(r.m, p, "requestMethod") as string) ?? "";
    const path = templatize(envoyField(r.m, p, "requestUrl") as string | undefined);
    const status = Number(envoyField(r.m, p, "status") ?? 0);
    const statusClass =
      status >= 500
        ? "5xx"
        : status >= 400
          ? "4xx"
          : status >= 300
            ? "3xx"
            : status >= 200
              ? "2xx"
              : status === 0
                ? "0"
                : String(status);
    // Envoy writes "-" for "no flags set"; treat it as absence, or every row counts
    // as an error and error_count degenerates into count.
    const rawFlags = (p.response_flags as string) ?? "";
    const flags = rawFlags === "-" ? "" : rawFlags;
    const dur = Number(p.duration_ms ?? 0);
    const upstream = labels.upstream_cluster ?? "";
    const { traceId, sampled } = extractTrace(r.m, p);
    const requestId = (envoyField(r.m, p, "requestId") as string | undefined) ?? null;
    const key = `${authority}|${method}|${path}|${statusClass}|${flags}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        authority,
        method,
        path,
        status_class: statusClass,
        flags,
        count: 0,
        error_count: 0,
        p50_ms: 0,
        p95_ms: 0,
        max_ms: 0,
        upstream_clusters: [],
        sample_trace: null,
        sample_request_id: null,
        durations: [],
      };
      groups.set(key, g);
    }
    g.count++;
    if (statusClass === "5xx" || statusClass === "4xx" || flags) g.error_count++;
    if (Number.isFinite(dur)) g.durations.push(dur);
    if (upstream && !g.upstream_clusters.includes(upstream) && g.upstream_clusters.length < 5) {
      g.upstream_clusters.push(upstream);
    }
    if (traceId && (!g.sample_trace || (sampled === true && g.sample_trace_sampled !== true))) {
      g.sample_trace = traceId;
      g.sample_trace_sampled = sampled;
    }
    if (!g.sample_request_id && requestId) g.sample_request_id = requestId;
    if (r.ts && (!g.lastTs || r.ts > g.lastTs)) g.lastTs = r.ts;
    if (r.ts && (!g.firstTs || r.ts < g.firstTs)) g.firstTs = r.ts;
  }
  return [...groups.values()]
    .map((g) => {
      const s = g.durations.slice().sort((a, b) => a - b);
      g.p50_ms = percentile(s, 50);
      g.p95_ms = percentile(s, 95);
      g.max_ms = s[s.length - 1] ?? 0;
      const { durations: _d, ...rest } = g;
      return rest;
    })
    .sort((a, b) => b.error_count - a.error_count || b.count - a.count);
}

const FILTER_HELP = `Logging query language filter.
ALWAYS scope it: resource.type AND a service selector (resource.labels.container_name / service_name / namespace_name). Dedupe keeps services separate, but an unscoped filter spends the whole page on whichever service is noisiest, so the one you care about never appears.
Prefer jsonPayload.<field> over textPayload: services emit structured JSON, textPayload matches only stringified logs.
Field homes differ because the GKE agent lifts GCP special fields onto the entry: top level = severity, timestamp, trace, spanId, labels.*, httpRequest.{requestMethod,requestUrl,status,remoteIp,userAgent,protocol}; payload = jsonPayload.{message,response_flags,duration_ms,upstream_host,upstream_service_time_ms} and jsonPayload.httpRequest.requestId (no room for it in the HttpRequest proto).
response_flags="-" means no flags set, not a missing field.
Unknown failure with no better lead: severity>=ERROR plus the suspect container.
severity ladder: DEBUG < INFO < NOTICE < WARNING < ERROR < CRITICAL < ALERT < EMERGENCY.
Examples:
- severity>=ERROR
- resource.type="k8s_container" AND resource.labels.namespace_name="default"
- textPayload:"database connection failed"
- jsonPayload.message=~"timeout"
- jsonPayload."service.name"="<service>"  // OpenTelemetry service name, when the app logs it
- jsonPayload.job="<cronjob name>"  // whole CronJob run's output
- jsonPayload.httpRequest.requestId="<id>"  // pinpoint one envoy entry from aggregate sample_request_id
- httpRequest.status>=500 AND jsonPayload.response_flags!="-"  // envoy-side failures only
- trace="projects/<project>/traces/<sample_trace>"  // ALL log lines for one request across services
Layer selectors:
- envoy sidecar or gateway: resource.labels.container_name="istio-proxy" AND labels."logging.gke.io/top_level_controller_name"="<controller>"
- backend container: resource.type="k8s_container" AND resource.labels.container_name="<service>"
- Cloud Function: resource.type="cloud_function" AND resource.labels.function_name="<name>"
Cloud Audit Logs are ORDINARY entries in this same tool, not a separate stream. Caller identity lives in protoPayload.authenticationInfo.principalEmail, the call in protoPayload.methodName + protoPayload.serviceName:
- logName="projects/<project>/logs/cloudaudit.googleapis.com%2Factivity"  // admin/config writes, always on, every service
- logName="projects/<project>/logs/cloudaudit.googleapis.com%2Fdata_access"  // per-caller API reads, OFF unless enabled per service
Which caller drove a read/query spike is answerable ONLY from data_access, and it exists only for the services the project auditConfigs enable. If a service has no data_access entries, say the log source is missing and name enabling DATA_READ for that service as the human fix.
An EMPTY data_access result proves nothing on its own. Two causes collapse into the same empty page: the audit config is off, or the entries exist and this agent's SA cannot see them (reading them needs roles/logging.privateLogViewer, which it does not hold, and private entries are filtered out silently instead of denied). Report it as "no readable audit entries", never as "auditing is off".`;

// The GCP Logging severity enum is case-sensitive and rejects lowercase or shorthand values with INVALID_ARGUMENT.
const SEVERITY_ALIASES: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO",
  notice: "NOTICE",
  warn: "WARNING",
  warning: "WARNING",
  err: "ERROR",
  error: "ERROR",
  crit: "CRITICAL",
  critical: "CRITICAL",
  alert: "ALERT",
  emerg: "EMERGENCY",
  emergency: "EMERGENCY",
  default: "DEFAULT",
};
function normalizeSeverity(filter: string): string {
  return filter.replace(/(\bseverity\s*(?:>=|<=|=|>|<|!=)\s*)"?([A-Za-z]+)"?/gi, (_m, lhs: string, val: string) => {
    const canon = SEVERITY_ALIASES[val.toLowerCase()] ?? val.toUpperCase();
    return `${lhs}${canon}`;
  });
}

const DENIED_HELP =
  "TERMINAL: Cloud Logging is unavailable for this agent's GCP identity. " +
  "No filter, project or resourceNames change fixes it — do not call gcp_logging_query again this session. " +
  "Continue with metrics, traces and source tools, and state in the diagnosis that log evidence was unreachable. " +
  "Fix (human, once): grant roles/logging.viewer to the opsremedy service account.";
const DENIED_VIEW_HELP =
  "The denial is on the resourceNames you passed, NOT on this project's default log scope. " +
  "Retry the same filter with resourceNames omitted before you give up on log evidence.";

function deniedHelp(hasResourceNames: boolean): string {
  return hasResourceNames ? DENIED_VIEW_HELP : DENIED_HELP;
}

function isPermissionDenied(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  if (code === 7 || code === "PERMISSION_DENIED") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /permission denied|PERMISSION_DENIED/i.test(msg);
}

function noMatchHints(filter: string): string[] {
  const hints: string[] = [];
  if (/textPayload/.test(filter)) {
    hints.push("textPayload matches only stringified logs; structured services emit JSON — retry with jsonPayload.message.");
  }
  if (/=~/.test(filter)) {
    hints.push(
      "=~ is a RE2 match on one field: it returns nothing when the field is absent, not when the text differs. Drop it first.",
    );
  }
  const named = filter.match(/(?:container_name|service_name|function_name|"service\.name")\s*=\s*"([^"]+)"/);
  if (named) {
    hints.push(
      `Confirm "${named[1]}" is the real selector value (k8s_get_pods for the container name) — a typo here matches zero rows silently.`,
    );
  }
  hints.push(
    "Separate 'nothing happened' from 'nothing matched': re-query with the resource selector ALONE (no severity, no message clause). Entries back means the log clauses are wrong; still empty means the window or the selector is.",
  );
  return hints;
}

export function gcpLoggingTool(defaultProject: string): SreTool {
  return {
    name: "gcp_logging_query",
    cheap: false,
    retry: true,
    description:
      "Search Google Cloud Logging within the alert window. Output is COMPACTED by default: " +
      "(a) envoy access logs grouped by route + status_class + flags, each group carrying count, error_count, p50/p95/max latency, upstream_clusters, sample_trace, sample_request_id; " +
      "(b) app logs deduped by (severity, service, message, error code/name), each carrying count, first/last timestamp, error_code/error_name, sample_trace, sample_span. " +
      'Holding a sample_trace, re-query HERE FIRST with `trace="projects/<project>/traces/<sample_trace>"`: that returns every log line of that one request across every service and usually root-causes the issue on its own. Works for any sample_trace, sampled or not. ' +
      "sample_trace_sampled=true means jaeger_get_trace WILL resolve that id; false means unknown, never proof the trace is missing — prefer a sampled id when several groups offer one. Reach for jaeger_get_trace only for span timing/topology the logs cannot give. " +
      'To inspect one entry: re-query with an aggregate\'s sample_request_id (`httpRequest.requestId="..."`), or pass raw=true to skip compaction (costs context — only once compaction has pointed at the row).',
    parameters: Type.Object({
      filter: Type.String({ description: FILTER_HELP }),
      resourceNames: Type.Optional(
        Type.Array(Type.String(), {
          description:
            `Defaults to ["projects/${defaultProject}"]. Pass a log-bucket view ` +
            `("projects/.../locations/.../buckets/.../views/...") only when the entries live outside that project.`,
        }),
      ),
      orderBy: Type.Optional(
        Type.Union([Type.Literal("timestamp desc"), Type.Literal("timestamp asc")], {
          description:
            "Default 'timestamp desc' (newest first). 'timestamp asc' reads a failure from its onset forward.",
        }),
      ),
      pageSize: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_PAGE_SIZE,
          description: `Max entries to return. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.`,
        }),
      ),
      pageToken: Type.Optional(Type.String({ description: "nextPageToken from a prior response." })),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Return raw log entries (no envoy aggregation, no app-log dedupe). " +
            "Use only once an aggregate pointed at a specific row and you need its full payload (stack trace, exact body). " +
            "Still capped at " +
            String(MAX_PAGE_SIZE) +
            " entries and ~32KB output.",
        }),
      ),
      startTime: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec." })),
      endTime: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec." })),
    }),
    execute: guarded(async (args, tw) => {
      const a = args as {
        filter: string;
        resourceNames?: string[];
        orderBy?: "timestamp desc" | "timestamp asc";
        pageSize?: number;
        pageToken?: string;
        startTime?: string;
        endTime?: string;
        raw?: boolean;
      };
      const win = tw.clamp({ startTime: a.startTime, endTime: a.endTime });
      const cleanFilter = normalizeSeverity(a.filter.replace(/\s*(AND|OR)\s*$/i, "").trim());
      const scopedFilter = `(${cleanFilter}) AND timestamp>="${win.startISO}" AND timestamp<"${win.endISO}"`;
      let entries: Entry[];
      let response: unknown;
      try {
        const res = await client(defaultProject).getEntries({
          filter: scopedFilter,
          resourceNames: a.resourceNames ?? [`projects/${defaultProject}`],
          orderBy: a.orderBy ?? "timestamp desc",
          pageSize: Math.min(a.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
          pageToken: a.pageToken,
          autoPaginate: false,
        });
        entries = res[0];
        response = res[2];
      } catch (e) {
        if (isPermissionDenied(e)) {
          const msg = e instanceof Error ? e.message : String(e);
          return textResult(`Error: ${msg}\n${deniedHelp(!!a.resourceNames?.length)}`, true);
        }
        throw e;
      }
      const rows = entries.map((e) => {
        const m = e.metadata as Record<string, unknown>;
        const res = m.resource as { type?: string; labels?: Record<string, string> } | undefined;
        const jp = (m.jsonPayload ?? (typeof e.data === "object" ? e.data : undefined)) as
          Record<string, unknown> | undefined;
        return {
          ts: m.timestamp as string | undefined,
          meta: m,
          severity: (m.severity as string | undefined) ?? "DEFAULT",
          service:
            (jp?.["service.name"] as string | undefined) ??
            (jp?.job as string | undefined) ??
            res?.labels?.container_name ??
            res?.labels?.service_name ??
            res?.labels?.function_name ??
            res?.type,
          text: typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? m.jsonPayload ?? m.textPayload ?? {}),
          payload: jp,
          ...extractTrace(m, jp),
        };
      });
      if (a.raw) {
        const url = logsExplorerUrl(defaultProject, cleanFilter, win.startISO, win.endISO);
        const entriesOut = rows.map((r) => ({
          ts: r.ts,
          severity: r.severity,
          service: r.service,
          payload: r.payload ?? r.text,
        }));
        const out: Record<string, unknown> = {
          total_entries: rows.length,
          logsExplorerUrl: url,
          entries: entriesOut,
          nextPageToken: (response as { nextPageToken?: string } | undefined)?.nextPageToken,
        };
        if (!rows.length) out.no_matches = noMatchHints(cleanFilter);
        return {
          content: [
            { type: "text", text: `Logs Explorer: ${url}` },
            { type: "text", text: JSON.stringify(out, null, 2) },
          ],
        };
      }
      const envoyRows = rows.filter((r) => isEnvoyAccess(r.payload));
      const appRows = rows.filter((r) => !isEnvoyAccess(r.payload));
      const envoyAggregates = aggregateEnvoy(envoyRows.map((r) => ({ ts: r.ts, p: r.payload!, m: r.meta })));
      const groups = new Map<
        string,
        {
          severity: string;
          service?: string;
          message: string;
          error_code?: string;
          error_name?: string;
          sample: string;
          count: number;
          firstTs?: string;
          lastTs?: string;
          sample_trace?: string;
          sample_trace_sampled?: boolean;
          sample_span?: string;
        }
      >();
      for (const r of appRows) {
        const sig = appSignature(r.payload, r.text);
        const key = `${r.severity}|${r.service ?? ""}|${sig.message}|${sig.errorCode ?? sig.errorName ?? ""}`;
        const g = groups.get(key);
        if (g) {
          g.count++;
          if (r.ts && (!g.lastTs || r.ts > g.lastTs)) g.lastTs = r.ts;
          if (r.ts && (!g.firstTs || r.ts < g.firstTs)) g.firstTs = r.ts;
          if (r.traceId && (!g.sample_trace || (r.sampled === true && g.sample_trace_sampled !== true))) {
            g.sample_trace = r.traceId;
            g.sample_trace_sampled = r.sampled;
            g.sample_span = r.spanId ?? undefined;
          }
        } else {
          groups.set(key, {
            severity: r.severity,
            service: r.service,
            message: sig.message,
            error_code: sig.errorCode,
            error_name: sig.errorName,
            sample: r.text.slice(0, 240),
            count: 1,
            firstTs: r.ts,
            lastTs: r.ts,
            sample_trace: r.traceId ?? undefined,
            sample_trace_sampled: r.sampled,
            sample_span: r.spanId ?? undefined,
          });
        }
      }
      const grouped = [...groups.values()].sort((a, b) => b.count - a.count);
      const url = logsExplorerUrl(defaultProject, cleanFilter, win.startISO, win.endISO);
      const out: Record<string, unknown> = {
        total_entries: rows.length,
        envoy_entries: envoyRows.length,
        app_entries: appRows.length,
        unique_patterns: grouped.length,
        logsExplorerUrl: url,
        patterns: grouped,
        nextPageToken: (response as { nextPageToken?: string } | undefined)?.nextPageToken,
      };
      if (envoyAggregates.length) out.envoy_aggregates = envoyAggregates;
      if (!rows.length) out.no_matches = noMatchHints(cleanFilter);
      return {
        content: [
          { type: "text", text: `Logs Explorer: ${url}` },
          { type: "text", text: JSON.stringify(out, null, 2) },
        ],
      };
    }),
  };
}
