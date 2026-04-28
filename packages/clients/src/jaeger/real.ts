import type { ServiceDep, TraceSummary } from "@opsremedy/core/types";
import type { JaegerClient, JaegerDepsQuery, JaegerTracesQuery } from "../types.ts";

export interface RealJaegerClientOptions {
  baseUrl: string;
  token?: string;
}

interface JaegerApiResponse<T> {
  data: T;
  errors?: Array<{ msg?: string; code?: number }>;
}

interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
}

interface JaegerSpan {
  spanID: string;
  traceID: string;
  operationName: string;
  duration: number; // microseconds
  startTime: number; // microseconds since epoch
  processID: string;
  references?: Array<{ refType: string; spanID: string; traceID: string }>;
  tags?: Array<{ key: string; type: string; value: unknown }>;
}

interface JaegerDependency {
  parent: string;
  child: string;
  callCount: number;
}

/**
 * Jaeger Query API client. Uses /api/traces and /api/dependencies.
 */
export class RealJaegerClient implements JaegerClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: RealJaegerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async findTraces(q: JaegerTracesQuery): Promise<TraceSummary[]> {
    // Jaeger expects microseconds. Center on the caller-provided endTime
    // (typically alert.fired_at) so historical alerts hit the right window;
    // fall back to wall-clock now for callers that don't pass endTime.
    const endMs = q.endTime ? q.endTime.getTime() : Date.now();
    const end = endMs * 1000;
    const start = end - q.lookbackMinutes * 60_000_000;
    const params = new URLSearchParams({
      service: q.service,
      start: String(start),
      end: String(end),
      limit: String(q.limit),
    });
    if (q.operation) params.set("operation", q.operation);
    if (q.minDurationMs !== undefined && q.minDurationMs > 0) {
      params.set("minDuration", `${q.minDurationMs}ms`);
    }
    const data = await this.get<JaegerTrace[]>("/api/traces", params, q.signal);
    return data.map(toTraceSummary);
  }

  async serviceDependencies(q: JaegerDepsQuery): Promise<ServiceDep[]> {
    const endTs = q.endTime ? q.endTime.getTime() : Date.now();
    const params = new URLSearchParams({
      endTs: String(endTs),
      lookback: String(q.lookbackMinutes * 60_000),
    });
    const data = await this.get<JaegerDependency[]>("/api/dependencies", params, q.signal);
    // Filter to edges that touch the requested service.
    return data
      .filter((d) => d.parent === q.service || d.child === q.service)
      .map((d) => ({ parent: d.parent, child: d.child, callCount: d.callCount }));
  }

  uiUrl(kind: "search" | "dependencies", service?: string): string {
    if (kind === "dependencies") return `${this.baseUrl}/dependencies`;
    if (!service) return `${this.baseUrl}/search`;
    return `${this.baseUrl}/search?service=${encodeURIComponent(service)}`;
  }

  private async get<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const res = await fetch(url, {
      headers: this.headers(),
      ...(signal !== undefined && { signal }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jaeger ${path} ${res.status}: ${body.slice(0, 200)}`);
    }
    const env = (await res.json()) as JaegerApiResponse<T>;
    if (env.errors?.length) {
      throw new Error(`Jaeger ${path} error: ${env.errors[0]?.msg ?? "unknown"}`);
    }
    return env.data;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.opts.token) h.Authorization = `Bearer ${this.opts.token}`;
    return h;
  }
}

function toTraceSummary(t: JaegerTrace): TraceSummary {
  const spans = t.spans ?? [];
  const root = findRootSpan(spans);
  const rootService = root ? (t.processes?.[root.processID]?.serviceName ?? "unknown") : "unknown";
  const totalUs = root?.duration ?? spans.reduce((m, s) => Math.max(m, s.duration), 0);
  const errored = spans.find(hasErrorTag);
  const slowest = spans.reduce<JaegerSpan | undefined>(
    (a, b) => (a && a.duration > b.duration ? a : b),
    undefined,
  );
  const noteworthy = errored
    ? `error span ${errored.operationName}`
    : slowest
      ? `${slowest.operationName} ${(slowest.duration / 1000).toFixed(1)}ms`
      : undefined;
  return {
    traceId: t.traceID,
    rootService,
    rootOperation: root?.operationName ?? "unknown",
    durationMs: totalUs / 1000,
    hasError: errored !== undefined,
    spanCount: spans.length,
    ...(noteworthy !== undefined && { noteworthySpan: noteworthy }),
  };
}

function findRootSpan(spans: JaegerSpan[]): JaegerSpan | undefined {
  return spans.find((s) => !s.references || s.references.length === 0);
}

function hasErrorTag(span: JaegerSpan): boolean {
  return (span.tags ?? []).some(
    (t) =>
      (t.key === "error" && t.value === true) ||
      (t.key === "otel.status_code" && String(t.value).toUpperCase() === "ERROR"),
  );
}
