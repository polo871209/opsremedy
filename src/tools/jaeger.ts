import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { sreTool, type SreTool } from "./types.ts";
import { textResult, guarded } from "./result.ts";
import { compactTrace } from "./trace-compact.ts";

// FindTraces scans the whole index for the window and overloads the Jaeger query service, so only GetTrace is exposed.
// HTTP API: https://www.jaegertracing.io/docs/latest/architecture/apis/#query-json-over-http
async function getTrace(baseUrl: string, traceId: string, startISO: string, endISO: string): Promise<unknown[]> {
  const url = new URL(`/api/v3/traces/${traceId}`, baseUrl);
  url.searchParams.set("startTime", startISO);
  url.searchParams.set("endTime", endISO);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`jaeger GetTrace: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { result?: { resourceSpans?: unknown[] } };
  return body.result?.resourceSpans ?? [];
}

const TRACE_ID_RE = /^[0-9a-f]{16}(?:[0-9a-f]{16})?$/;
function normalizeTraceId(raw: string): string | undefined {
  const id = raw
    .trim()
    .replace(/^projects\/[^/]+\/traces\//, "")
    .toLowerCase();
  return TRACE_ID_RE.test(id) ? id : undefined;
}

function getTraceTool(baseUrl: string): SreTool {
  return sreTool({
    name: "jaeger_get_trace",
    cheap: false,
    retry: true,
    description:
      "Span tree of one trace in the alert window, for per-request timing and cross-service flow. " +
      "It cannot search, so the id must come from a gcp_logging_query sample_trace. Without one, stay in the logs. " +
      "Spans come sorted by start time, with the http., rpc., db., messaging., exception., peer. and error attributes. " +
      "The innermost span with error set is where the failure started. Its ancestors only pass the error up. " +
      "Only sampled requests have spans, so prefer an id with sample_trace_sampled=true. " +
      "An empty result means that the request was not sampled. Never cite it or retry it. Query gcp_logging_query with that trace instead.",
    parameters: obj({
      traceId: str({
        description: "16 or 32 hex characters, or the 'projects/<project>/traces/<id>' form.",
      }),
      raw: opt(
        bool({
          description:
            "Return the untouched OTel resourceSpans with every attribute. Use it only when a dropped attribute is the answer, because a wide trace gets truncated.",
        }),
      ),
    }),
    execute: guarded(async (a, tw) => {
      const traceId = normalizeTraceId(a.traceId ?? "");
      if (!traceId) {
        return textResult(
          `Rejected: ${JSON.stringify(a.traceId)} is not a trace ID. Pass 16 or 32 hex characters from a gcp_logging_query sample_trace. ` +
            `This tool cannot search by service, operation, or free text.`,
          true,
        );
      }
      const resourceSpans = await getTrace(baseUrl, traceId, tw.startISO(), tw.endISO());
      if (a.raw) return textResult({ resourceSpans });
      return textResult({ trace_id: traceId, ...compactTrace(resourceSpans) });
    }),
  });
}

export function jaegerTools(baseUrl: string): SreTool[] {
  return [getTraceTool(baseUrl)];
}
