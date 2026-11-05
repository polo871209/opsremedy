import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import { sreTool, type SreTool } from "./types.ts";
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

const MATCH_HELP =
  "Series matchers with a concrete metric name, for example ['up{job=\"k8s\"}']. GMP rejects a matcher whose only selector is a regex on __name__.";

function instantQueryTool(promUrl: string, grafanaUrl: string, datasource: string): SreTool {
  return sreTool({
    name: "promql_instant",
    cheap: false,
    retry: true,
    description:
      "Evaluate PromQL at one instant, by default the alert end or now. For onset, trend or recovery, use promql_range. Returns the result and a Grafana link.",
    parameters: obj({
      query: str({ description: "PromQL expression" }),
      time: opt(str({ description: "ISO8601 or unix-ms/sec. Default = alert end." })),
    }),
    execute: guarded(async (a, tw) => {
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
  });
}

function rangeQueryTool(promUrl: string, grafanaUrl: string, datasource: string): SreTool {
  return sreTool({
    name: "promql_range",
    cheap: false,
    retry: true,
    description:
      "Evaluate PromQL across the alert window. Returns min, max, p50, p95, first and last per series, not raw samples, and a Grafana link. " +
      "GMP scrapes every 30s, so use range vectors of [5m] or longer.",
    parameters: obj({
      query: str({ description: "PromQL expression" }),
      step: opt(str({ description: "e.g. 30s, 1m (default 30s)" })),
      startTime: opt(str({ description: "ISO8601 or unix-ms/sec. Default = window start." })),
      endTime: opt(str({ description: "ISO8601 or unix-ms/sec. Default = window end." })),
    }),
    execute: guarded(async (a, tw) => {
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
  });
}

function listMetricsTool(promUrl: string): SreTool {
  return sreTool({
    name: "prom_list_metrics",
    cheap: true,
    retry: true,
    description: "List metric names. Always pass `contains`, because the unfiltered list is cut at `limit`.",
    parameters: obj({
      contains: opt(
        str({
          description: "Case-insensitive substring, for example 'kafka', 'consumer' or 'clickhouse'.",
        }),
      ),
      limit: opt(int({ minimum: 1, maximum: 500, default: 100 })),
    }),
    execute: guarded(async (a) => {
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
  });
}

function metricMetadataTool(promUrl: string): SreTool {
  return sreTool({
    name: "prom_metric_metadata",
    cheap: true,
    retry: true,
    description:
      "HELP, TYPE and UNIT of a metric. Read it before you query an unfamiliar metric, because TYPE decides whether rate() or histogram_quantile() applies.",
    parameters: obj({
      metric: opt(str({ description: "Exact metric name" })),
      limit: opt(int({ minimum: 1, maximum: 200, default: 50 })),
    }),
    execute: guarded(async (a) => {
      const params = new URLSearchParams();
      if (a.metric) params.set("metric", a.metric);
      params.set("limit", String(a.limit ?? 50));
      const { ok, body } = await promFetch(promUrl, "/api/v1/metadata", params);
      return textResult(body, !ok);
    }),
  });
}

function labelNamesTool(promUrl: string): SreTool {
  return sreTool({
    name: "prom_label_names",
    cheap: true,
    retry: true,
    description: "Label names on the matched series. Read them before you write a selector.",
    parameters: obj({
      match: opt(
        arr(str(), {
          description: MATCH_HELP,
        }),
      ),
    }),
    execute: guarded(async (a) => {
      const params = new URLSearchParams();
      for (const m of a.match ?? []) params.append("match[]", m);
      const { ok, body } = await promFetch(promUrl, "/api/v1/labels", params);
      return textResult(body, !ok);
    }),
  });
}

function labelValuesTool(promUrl: string): SreTool {
  return sreTool({
    name: "prom_label_values",
    cheap: true,
    retry: true,
    description:
      "Values of one label on the matched series. Use it to make sure that a namespace, pod, container or consumergroup exists before you select on it.",
    parameters: obj({
      label: str(),
      match: opt(
        arr(str(), {
          description: MATCH_HELP,
        }),
      ),
    }),
    execute: guarded(async (a) => {
      const params = new URLSearchParams();
      for (const m of a.match ?? []) params.append("match[]", m);
      const { ok, body } = await promFetch(promUrl, `/api/v1/label/${encodeURIComponent(a.label)}/values`, params);
      return textResult(body, !ok);
    }),
  });
}

function seriesTool(promUrl: string): SreTool {
  return sreTool({
    name: "prom_series",
    cheap: true,
    retry: true,
    description:
      "Series that a matcher resolves to in the alert window, with their labels. " +
      "An empty result usually means a wrong label or metric name, and sometimes a workload that stopped reporting.",
    parameters: obj({
      match: arr(str(), {
        description: MATCH_HELP,
      }),
    }),
    execute: guarded(async (a, tw) => {
      const params = new URLSearchParams();
      for (const m of a.match) params.append("match[]", m);
      params.set("start", String(tw.startUnix()));
      params.set("end", String(tw.endUnix()));
      const { ok, body } = await promFetch(promUrl, "/api/v1/series", params);
      return textResult(body, !ok);
    }),
  });
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
