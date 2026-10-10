import { Type } from "@earendil-works/pi-ai";
import type { SreTool } from "./types.ts";
import { textResult, guarded } from "./result.ts";

// Grafana Explore deep link, modern `panes` schema (Grafana 10+).
function grafanaExploreUrl(
  grafanaUrl: string,
  datasourceUid: string,
  expr: string,
  range: { from: string; to: string },
): string {
  let h = 0;
  for (const ch of `${expr}|${range.from}|${range.to}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const paneId = Math.abs(h).toString(36).slice(0, 3).padStart(3, "0");
  const panes = {
    [paneId]: {
      datasource: datasourceUid,
      queries: [
        {
          refId: "A",
          expr,
          range: true,
          instant: true,
          datasource: { type: "prometheus", uid: datasourceUid },
          editorMode: "code",
          legendFormat: "__auto",
        },
      ],
      range,
      compact: false,
    },
  };
  const base = grafanaUrl.replace(/\/$/, "");
  return `${base}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}&orgId=1`;
}

// GMP rejects selectors that vanilla Prometheus accepts, because every GCP-exported metric is scoped to one monitored resource type.
function gmpHint(err: string): string | undefined {
  const ambiguous = err.match(/multiple monitored resource types \[([^\]]+)\]/);
  if (ambiguous) {
    const options = ambiguous[1]!.trim().split(/\s+/);
    return `Pick ONE monitored_resource and match it exactly: ${options
      .map((o) => `monitored_resource="${o}"`)
      .join(" or ")}. It belongs inside the selector braces, not in \`by (...)\`.`;
  }
  if (/exact monitored resource name/.test(err)) {
    return (
      "monitored_resource takes = only: no regex, no negation, no bare discovery. " +
      "Read its values with prom_label_values(label='monitored_resource', match=['<metric>']), then match one exactly."
    );
  }
  const mismatch = err.match(/metric type (\S+) is not queryable for monitored resource (\S+?):/);
  if (mismatch) {
    return (
      `${mismatch[1]} is not exported under monitored_resource="${mismatch[2]}". ` +
      "Each GCP metric carries its own resource type, so a value that worked for a sibling metric does not transfer — " +
      `re-read it with prom_label_values(label='monitored_resource', match=['${mismatch[1]}']).`
    );
  }
  return undefined;
}

export async function promFetch(
  baseUrl: string,
  path: string,
  params: URLSearchParams,
): Promise<{ ok: boolean; body: unknown }> {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
  for (const [k, v] of params) u.searchParams.append(k, v);
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json();
  const ok = res.ok && (body as { status?: string }).status === "success";
  if (ok) return { ok, body };
  const hint = gmpHint(String((body as { error?: string }).error ?? ""));
  return { ok, body: hint ? { ...(body as object), hint } : body };
}

function summarizeRange(body: unknown): unknown {
  const r = (body as { data?: { result?: { metric: Record<string, string>; values: [number, string][] }[] } })?.data
    ?.result;
  if (!Array.isArray(r)) return body;
  const series = r.map((s) => {
    const nums = s.values.map(([, v]) => Number(v)).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return { metric: s.metric, n: 0 };
    const sorted = [...nums].sort((a, b) => a - b);
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      metric: s.metric,
      n: nums.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: pick(0.5),
      p95: pick(0.95),
      first: nums[0],
      last: nums[nums.length - 1],
    };
  });
  return { resultType: "matrix", seriesCount: series.length, series };
}

function instantQueryTool(promUrl: string, grafanaUrl: string, datasource: string): SreTool {
  return {
    name: "promql_instant",
    cheap: false,
    retry: true,
    description:
      "Evaluate a PromQL expression at ONE instant, by default the alert end (or now if still firing). " +
      "For anything shaped over time — onset, trend, recovery — use promql_range instead. Returns the result plus a Grafana Explore link.",
    parameters: Type.Object({
      query: Type.String({ description: "PromQL expression" }),
      time: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec. Default = alert end." })),
    }),
    execute: guarded(async (args, tw) => {
      const a = args as { query: string; time?: string };
      const win = tw.clamp({ endTime: a.time });
      const params = new URLSearchParams({ query: a.query, time: String(win.endUnix) });
      const { ok, body } = await promFetch(promUrl, "/api/v1/query", params);
      return textResult(
        {
          grafanaUrl: grafanaExploreUrl(grafanaUrl, datasource, a.query, {
            from: String(tw.startMs()),
            to: tw.isOpen ? "now" : String(tw.endMs()),
          }),
          result: body,
        },
        !ok,
      );
    }),
  };
}

function rangeQueryTool(promUrl: string, grafanaUrl: string, datasource: string): SreTool {
  return {
    name: "promql_range",
    cheap: false,
    retry: true,
    description:
      "Evaluate a PromQL expression across the alert window (default) — the tool for onset, trend, and recovery. " +
      "Prefer range vectors of [5m] or larger: GMP scrapes at 30s, so shorter windows hold too few samples for a stable rate. " +
      "Returns per-series stats {min,max,p50,p95,first,last} (NOT raw sample arrays) + a Grafana Explore link.",
    parameters: Type.Object({
      query: Type.String({ description: "PromQL expression" }),
      step: Type.Optional(Type.String({ description: "e.g. 30s, 1m (default 30s)" })),
      startTime: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec. Default = window start." })),
      endTime: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec. Default = window end." })),
    }),
    execute: guarded(async (args, tw) => {
      const a = args as { query: string; step?: string; startTime?: string; endTime?: string };
      const win = tw.clamp({ startTime: a.startTime, endTime: a.endTime });
      const params = new URLSearchParams({
        query: a.query,
        start: String(win.startUnix),
        end: String(win.endUnix),
        step: a.step ?? "30s",
      });
      const { ok, body } = await promFetch(promUrl, "/api/v1/query_range", params);
      return textResult(
        {
          grafanaUrl: grafanaExploreUrl(grafanaUrl, datasource, a.query, {
            from: String(tw.startMs()),
            to: tw.isOpen ? "now" : String(tw.endMs()),
          }),
          result: ok ? summarizeRange(body) : body,
        },
        !ok,
      );
    }),
  };
}

function listMetricsTool(promUrl: string): SreTool {
  return {
    name: "prom_list_metrics",
    cheap: true,
    retry: true,
    description:
      "List metric names. ALWAYS pass `contains`: unfiltered, the first 100 names returned are rarely the relevant ones.",
    parameters: Type.Object({
      contains: Type.Optional(
        Type.String({
          description:
            "Substring filter (case-insensitive). Use a topic/service/component fragment, e.g. 'kafka', 'consumer', 'clickhouse'.",
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
    }),
    execute: guarded(async (args) => {
      const a = args as { contains?: string; limit?: number };
      const { ok, body } = await promFetch(promUrl, "/api/v1/label/__name__/values", new URLSearchParams());
      if (!ok) return textResult(body, true);
      let names = ((body as { data?: string[] }).data ?? []) as string[];
      if (a.contains) {
        const needle = a.contains.toLowerCase();
        names = names.filter((n) => n.toLowerCase().includes(needle));
      }
      const limit = a.limit ?? 100;
      return textResult({
        total: names.length,
        returned: Math.min(names.length, limit),
        metrics: names.slice(0, limit),
      });
    }),
  };
}

function metricMetadataTool(promUrl: string): SreTool {
  return {
    name: "prom_metric_metadata",
    cheap: true,
    retry: true,
    description:
      "HELP + TYPE + UNIT for a metric. Read it before querying an unfamiliar metric — TYPE decides whether rate()/histogram_quantile() even applies.",
    parameters: Type.Object({
      metric: Type.Optional(Type.String({ description: "Exact metric name (optional)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    }),
    execute: guarded(async (args) => {
      const a = args as { metric?: string; limit?: number };
      const params = new URLSearchParams();
      if (a.metric) params.set("metric", a.metric);
      if (a.limit) params.set("limit", String(a.limit));
      const { ok, body } = await promFetch(promUrl, "/api/v1/metadata", params);
      return textResult(body, !ok);
    }),
  };
}

function labelNamesTool(promUrl: string): SreTool {
  return {
    name: "prom_label_names",
    cheap: true,
    retry: true,
    description:
      "List label names carried by matched series — use it to learn how a metric is sliced before writing a selector. " +
      "GMP rejects a matcher whose only selector is a regex on __name__, so `match` needs a concrete metric name.",
    parameters: Type.Object({
      match: Type.Optional(
        Type.Array(Type.String(), {
          description: "Series matchers, concrete metric name required, e.g. ['up{job=\"k8s\"}']",
        }),
      ),
    }),
    execute: guarded(async (args) => {
      const a = args as { match?: string[] };
      const params = new URLSearchParams();
      for (const m of a.match ?? []) params.append("match[]", m);
      const { ok, body } = await promFetch(promUrl, "/api/v1/labels", params);
      return textResult(body, !ok);
    }),
  };
}

function labelValuesTool(promUrl: string): SreTool {
  return {
    name: "prom_label_values",
    cheap: true,
    retry: true,
    description:
      "Values a label actually takes — the way to confirm a namespace, pod, container, service or consumergroup exists before selecting on it. " +
      "GMP rejects a matcher whose only selector is a regex on __name__, so `match` needs a concrete metric name.",
    parameters: Type.Object({
      label: Type.String({ description: "Label name, e.g. namespace, pod" }),
      match: Type.Optional(
        Type.Array(Type.String(), {
          description: "Series matchers, concrete metric name required, e.g. ['up{job=\"k8s\"}']",
        }),
      ),
    }),
    execute: guarded(async (args) => {
      const a = args as { label: string; match?: string[] };
      const params = new URLSearchParams();
      for (const m of a.match ?? []) params.append("match[]", m);
      const { ok, body } = await promFetch(promUrl, `/api/v1/label/${encodeURIComponent(a.label)}/values`, params);
      return textResult(body, !ok);
    }),
  };
}

function seriesTool(promUrl: string): SreTool {
  return {
    name: "prom_series",
    cheap: true,
    retry: true,
    description:
      "List the series a matcher resolves to within the alert window, label sets included — the check that a selector will return data before querying it. " +
      "Empty means nothing matched: usually a wrong label or metric name, occasionally a workload that stopped reporting.",
    parameters: Type.Object({
      match: Type.Array(Type.String(), {
        description: "Series matchers, concrete metric name required (GMP), e.g. ['up{job=\"k8s\"}']",
      }),
    }),
    execute: guarded(async (args, tw) => {
      const a = args as { match: string[] };
      const params = new URLSearchParams();
      for (const m of a.match) params.append("match[]", m);
      params.set("start", String(tw.startUnix()));
      params.set("end", String(tw.endUnix()));
      const { ok, body } = await promFetch(promUrl, "/api/v1/series", params);
      return textResult(body, !ok);
    }),
  };
}

export function promTools(promUrl: string, grafanaUrl: string, datasource: string): SreTool[] {
  return [
    listMetricsTool(promUrl),
    metricMetadataTool(promUrl),
    labelNamesTool(promUrl),
    labelValuesTool(promUrl),
    seriesTool(promUrl),
    instantQueryTool(promUrl, grafanaUrl, datasource),
    rangeQueryTool(promUrl, grafanaUrl, datasource),
  ];
}
