import type {
  PromInstantResult,
  PromMetricMetadata,
  PromRuleState,
  PromSeriesResult,
  PromTarget,
} from "@opsremedy/core/types";
import type {
  PromClient,
  PromInstantQuery,
  PromMetadataQuery,
  PromMetricsListQuery,
  PromRangeQuery,
  PromTargetsQuery,
} from "../types.ts";

export interface RealPromClientOptions {
  baseUrl: string;
  bearerToken?: string;
  basicAuth?: { user: string; password: string };
  /**
   * Async token provider, called per request. Used for short-lived tokens
   * (e.g. Google Managed Prometheus access tokens, default TTL 1h) so a
   * single CLI run can keep working past expiry. Wins over `bearerToken`
   * when both are set.
   */
  tokenProvider?: () => Promise<string>;
}

interface PromApiEnvelope<T> {
  status: "success" | "error";
  data?: T;
  errorType?: string;
  error?: string;
}

interface PromInstantData {
  resultType: "scalar" | "vector" | "matrix" | "string";
  result: Array<{
    metric: Record<string, string>;
    value?: [number, string];
    values?: Array<[number, string]>;
  }>;
}

interface PromRangeData {
  resultType: "matrix";
  result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
}

interface PromRulesData {
  groups: Array<{
    rules: Array<{
      type?: string;
      name: string;
      query: string;
      labels?: Record<string, string>;
      state?: "firing" | "pending" | "inactive";
      lastEvaluation?: string;
      activeAt?: string;
    }>;
  }>;
}

/**
 * `/api/v1/metadata` returns either Record<metric, MetadataItem[]> (vanilla
 * Prom) or a flat array (some downstreams). We normalise to the array form.
 */
type PromMetadataRaw =
  | Record<string, Array<{ type?: string; help?: string; unit?: string }>>
  | Array<{ metric?: string; type?: string; help?: string; unit?: string }>;

interface PromTargetRaw {
  discoveredLabels?: Record<string, string>;
  labels?: Record<string, string>;
  scrapePool?: string;
  scrapeUrl?: string;
  globalUrl?: string;
  lastError?: string;
  lastScrape?: string;
  health?: "up" | "down" | "unknown";
}

interface PromTargetsData {
  activeTargets?: PromTargetRaw[];
  droppedTargets?: PromTargetRaw[];
}

/**
 * Prometheus HTTP API client. Uses native fetch.
 * Supports bearer token or HTTP basic auth.
 */
export class RealPromClient implements PromClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: RealPromClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async instant(q: PromInstantQuery): Promise<PromInstantResult> {
    const params = new URLSearchParams({ query: q.query });
    if (q.time) params.set("time", String(q.time.getTime() / 1000));
    const data = await this.get<PromInstantData>("/api/v1/query", params, q.signal);
    const series = data.result.map((s) => ({
      metric: s.metric,
      value: pickInstantSample(s),
    }));
    const resultType = (data.resultType ?? "vector") as PromInstantResult["resultType"];
    return { resultType, series };
  }

  async range(q: PromRangeQuery): Promise<PromSeriesResult> {
    const params = new URLSearchParams({
      query: q.query,
      start: String(q.start.getTime() / 1000),
      end: String(q.end.getTime() / 1000),
      step: String(q.step),
    });
    const data = await this.get<PromRangeData>("/api/v1/query_range", params, q.signal);
    const series = data.result.map((s) => ({
      metric: s.metric,
      values: s.values.map(([ts, v]) => ({ timestamp: ts, value: Number(v) })),
    }));
    return { series };
  }

  async alertRules(signal?: AbortSignal): Promise<PromRuleState[]> {
    const data = await this.get<PromRulesData>(
      "/api/v1/rules",
      new URLSearchParams({ type: "alert" }),
      signal,
    );
    const out: PromRuleState[] = [];
    for (const group of data.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (rule.type && rule.type !== "alerting") continue;
        const state = rule.state ?? "inactive";
        const lastTransition = rule.activeAt
          ? Math.floor(new Date(rule.activeAt).getTime() / 1000)
          : undefined;
        out.push({
          name: rule.name,
          state,
          query: rule.query,
          labels: rule.labels ?? {},
          ...(lastTransition !== undefined && Number.isFinite(lastTransition) && { lastTransition }),
        });
      }
    }
    return out;
  }

  async listMetrics(q: PromMetricsListQuery): Promise<string[]> {
    // Prom + GMP both expose label values via /api/v1/label/<label>/values.
    const data = await this.get<string[]>("/api/v1/label/__name__/values", new URLSearchParams(), q.signal);
    let names = Array.isArray(data) ? data : [];
    if (q.contains) {
      const needle = q.contains.toLowerCase();
      names = names.filter((n) => n.toLowerCase().includes(needle));
    }
    const limit = q.limit ?? 200;
    return names.slice(0, limit);
  }

  async metricMetadata(q: PromMetadataQuery): Promise<PromMetricMetadata[]> {
    const params = new URLSearchParams();
    if (q.metric) params.set("metric", q.metric);
    if (q.perMetricLimit !== undefined) params.set("limit_per_metric", String(q.perMetricLimit));
    const data = await this.get<PromMetadataRaw>("/api/v1/metadata", params, q.signal);
    return normaliseMetadata(data);
  }

  async targets(q: PromTargetsQuery): Promise<PromTarget[]> {
    const params = new URLSearchParams();
    params.set("state", q.state ?? "active");
    const data = await this.get<PromTargetsData>("/api/v1/targets", params, q.signal);
    const sources: PromTargetRaw[] = [];
    if (data.activeTargets) sources.push(...data.activeTargets);
    if (q.state === "dropped" || q.state === "any") {
      if (data.droppedTargets) sources.push(...data.droppedTargets);
    }
    const out: PromTarget[] = sources.map((t) => {
      const labels = t.labels ?? {};
      const target: PromTarget = {
        job: labels.job ?? t.scrapePool ?? "",
        instance: labels.instance ?? "",
        health: t.health ?? "unknown",
        labels,
      };
      if (t.scrapeUrl !== undefined) target.scrapeUrl = t.scrapeUrl;
      if (t.lastError !== undefined && t.lastError.length > 0) target.lastError = t.lastError;
      if (t.lastScrape !== undefined) target.lastScrape = t.lastScrape;
      return target;
    });
    return q.job ? out.filter((t) => t.job === q.job) : out;
  }

  uiUrl(kind: "graph" | "alerts", query?: string): string {
    if (kind === "alerts") return `${this.baseUrl}/alerts`;
    if (!query) return `${this.baseUrl}/graph`;
    return `${this.baseUrl}/graph?g0.expr=${encodeURIComponent(query)}&g0.tab=0`;
  }

  private async get<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const res = await fetch(url, {
      headers: await this.headers(),
      ...(signal !== undefined && { signal }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Prometheus ${path} ${res.status}: ${body.slice(0, 200)}`);
    }
    const env = (await res.json()) as PromApiEnvelope<T>;
    if (env.status !== "success" || env.data === undefined) {
      throw new Error(`Prometheus ${path} returned ${env.status}: ${env.error ?? "(no error)"}`);
    }
    return env.data;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.opts.tokenProvider) {
      const token = await this.opts.tokenProvider();
      h.Authorization = `Bearer ${token}`;
    } else if (this.opts.bearerToken) {
      h.Authorization = `Bearer ${this.opts.bearerToken}`;
    } else if (this.opts.basicAuth) {
      const { user, password } = this.opts.basicAuth;
      h.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    }
    return h;
  }
}

function normaliseMetadata(raw: PromMetadataRaw): PromMetricMetadata[] {
  const out: PromMetricMetadata[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item.metric) continue;
      out.push({
        metric: item.metric,
        type: (item.type ?? "unknown") as PromMetricMetadata["type"],
        help: item.help ?? "",
        ...(item.unit !== undefined && item.unit.length > 0 && { unit: item.unit }),
      });
    }
    return out;
  }
  for (const [metric, items] of Object.entries(raw)) {
    const first = items?.[0];
    if (!first) continue;
    out.push({
      metric,
      type: (first.type ?? "unknown") as PromMetricMetadata["type"],
      help: first.help ?? "",
      ...(first.unit !== undefined && first.unit.length > 0 && { unit: first.unit }),
    });
  }
  return out;
}

function pickInstantSample(s: { value?: [number, string]; values?: Array<[number, string]> }): {
  timestamp: number;
  value: number;
} {
  if (s.value) return { timestamp: s.value[0], value: Number(s.value[1]) };
  const last = s.values?.[s.values.length - 1];
  if (last) return { timestamp: last[0], value: Number(last[1]) };
  return { timestamp: 0, value: Number.NaN };
}
