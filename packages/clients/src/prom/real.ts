import type { PromInstantResult, PromRuleState, PromSeriesResult } from "@opsremedy/core/types";
import type { PromClient, PromInstantQuery, PromRangeQuery } from "../types.ts";

export interface RealPromClientOptions {
  baseUrl: string;
  bearerToken?: string;
  basicAuth?: { user: string; password: string };
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

  uiUrl(kind: "graph" | "alerts", query?: string): string {
    if (kind === "alerts") return `${this.baseUrl}/alerts`;
    if (!query) return `${this.baseUrl}/graph`;
    return `${this.baseUrl}/graph?g0.expr=${encodeURIComponent(query)}&g0.tab=0`;
  }

  private async get<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const res = await fetch(url, {
      headers: this.headers(),
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.opts.bearerToken) {
      h.Authorization = `Bearer ${this.opts.bearerToken}`;
    } else if (this.opts.basicAuth) {
      const { user, password } = this.opts.basicAuth;
      h.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    }
    return h;
  }
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
