
export interface CompactSpan {
  service: string;
  name: string;
  span_id: string;
  parent_span_id?: string;
  start_ms: number;
  dur_ms: number;
  error?: string;
  attrs?: Record<string, string>;
}

const KEEP_PREFIXES = ["http.", "rpc.", "db.", "messaging.", "exception.", "peer.", "error"];
const ATTR_VALUE_MAX = 200;
const DROP_KEYS = new Set(["db.connection_string", "http.request.header", "http.response.header"]);

type AnyRec = Record<string, unknown>;

function attrValue(v: unknown): string | undefined {
  if (v == null || typeof v !== "object") return v == null ? undefined : String(v);
  const o = v as AnyRec;
  const raw =
    (o.stringValue as string) ??
    (o.intValue as string) ??
    (o.doubleValue as number) ??
    (o.boolValue as boolean) ??
    undefined;
  if (raw === undefined) return undefined;
  const s = String(raw);
  return s.length > ATTR_VALUE_MAX ? `${s.slice(0, ATTR_VALUE_MAX)}…` : s;
}

function pickAttrs(list: unknown): Record<string, string> | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: Record<string, string> = {};
  for (const kv of list as AnyRec[]) {
    const key = typeof kv?.key === "string" ? kv.key : undefined;
    if (!key || DROP_KEYS.has(key)) continue;
    if (!KEEP_PREFIXES.some((p) => key.startsWith(p))) continue;
    const val = attrValue(kv.value);
    if (val !== undefined && val !== "") out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function serviceName(resource: unknown): string {
  const attrs = (resource as AnyRec)?.attributes;
  if (!Array.isArray(attrs)) return "unknown";
  for (const kv of attrs as AnyRec[]) {
    if (kv?.key === "service.name") return attrValue(kv.value) ?? "unknown";
  }
  return "unknown";
}

export function compactTrace(resourceSpans: unknown[]): {
  span_count: number;
  duration_ms: number;
  services: string[];
  error_spans: number;
  spans: CompactSpan[];
} {
  const flat: (CompactSpan & { startNano: bigint })[] = [];
  for (const rs of (resourceSpans ?? []) as AnyRec[]) {
    const service = serviceName(rs.resource);
    for (const ss of (rs.scopeSpans ?? []) as AnyRec[]) {
      for (const s of (ss.spans ?? []) as AnyRec[]) {
        const start = BigInt((s.startTimeUnixNano as string) ?? "0");
        const end = BigInt((s.endTimeUnixNano as string) ?? "0");
        const status = s.status as AnyRec | undefined;
        const isError = status?.code === "STATUS_CODE_ERROR" || status?.code === 2;
        flat.push({
          startNano: start,
          service,
          name: String(s.name ?? ""),
          span_id: String(s.spanId ?? ""),
          parent_span_id: s.parentSpanId ? String(s.parentSpanId) : undefined,
          start_ms: 0,
          dur_ms: Number((end - start) / 1000n) / 1000,
          error: isError ? String(status?.message ?? "") || "STATUS_CODE_ERROR" : undefined,
          attrs: pickAttrs(s.attributes),
        });
      }
    }
  }
  flat.sort((a, b) =>
    a.startNano < b.startNano ? -1 : a.startNano > b.startNano ? 1 : a.span_id < b.span_id ? -1 : 1,
  );
  const t0 = flat.length ? flat[0]!.startNano : 0n;
  const spans = flat.map(({ startNano, ...rest }) => ({
    ...rest,
    start_ms: Number((startNano - t0) / 1000n) / 1000,
  }));
  const endMs = spans.reduce((m, s) => Math.max(m, s.start_ms + s.dur_ms), 0);
  return {
    span_count: spans.length,
    duration_ms: Number(endMs.toFixed(3)),
    services: [...new Set(spans.map((s) => s.service))].sort(),
    error_spans: spans.filter((s) => s.error).length,
    spans,
  };
}
