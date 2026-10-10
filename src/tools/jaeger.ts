import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { SreTool } from "./types.ts";
import { textResult, guarded } from "./result.ts";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { compactTrace } from "./trace-compact.ts";

const PROTO_ROOT = resolve(import.meta.dir, "../../protos");

interface GetTraceRequest {
  traceId: string;
  startTime?: ReturnType<typeof isoToTimestamp>;
  endTime?: ReturnType<typeof isoToTimestamp>;
}

// FindTraces, GetServices and GetOperations scan the whole index for the window and overload the Jaeger query service.
type GrpcClient = grpc.Client & {
  GetTrace(req: GetTraceRequest, opts: grpc.CallOptions): NodeJS.ReadableStream;
};
let _client: GrpcClient | undefined;
let _clientAddr: string | undefined;

function getClient(addr: string): GrpcClient {
  if (_client && _clientAddr === addr) return _client;
  const def = protoLoader.loadSync("jaeger/api_v3/query_service.proto", {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const Svc = pkg.jaeger.api_v3.QueryService as grpc.ServiceClientConstructor;
  _client = new Svc(addr, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  }) as unknown as GrpcClient;
  _clientAddr = addr;
  return _client;
}

function deadline(): grpc.CallOptions {
  return { deadline: Date.now() + 30_000 };
}

interface TracesData {
  resourceSpans?: unknown[];
}
function getTrace(client: GrpcClient, req: GetTraceRequest): Promise<TracesData> {
  return new Promise((res, rej) => {
    const stream = client.GetTrace(req, deadline());
    const merged: unknown[] = [];
    stream.on("data", (chunk: TracesData) => {
      if (chunk.resourceSpans) merged.push(...chunk.resourceSpans);
    });
    stream.on("error", rej);
    stream.on("end", () => res({ resourceSpans: merged }));
  });
}

interface OtelSpan {
  traceId?: string | Buffer;
  spanId?: string | Buffer;
  parentSpanId?: string | Buffer;
}
interface OtelResourceSpans {
  scopeSpans?: { spans?: OtelSpan[] }[];
}

function toHex(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  return String(v);
}

function isoToTimestamp(iso?: string) {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}

const TRACE_ID_RE = /^[0-9a-f]{16}(?:[0-9a-f]{16})?$/;
function normalizeTraceId(raw: string): string | undefined {
  const id = raw
    .trim()
    .replace(/^projects\/[^/]+\/traces\//, "")
    .toLowerCase();
  return TRACE_ID_RE.test(id) ? id : undefined;
}

function getTraceTool(addr: string): SreTool {
  return {
    name: "jaeger_get_trace",
    cheap: false,
    retry: true,
    description:
      "Span tree for one hex trace ID, fetched within the alert window. Answers per-request timing and cross-service topology. " +
      "The only jaeger tool: trace search by service or operation does not exist, so the id MUST come from a log line (a gcp_logging_query sample_trace). Without one, stay in the logs. " +
      "Returns spans ALREADY SORTED by start time, each with service, name, span_id, parent_span_id, start_ms (offset from trace start), dur_ms, error, and the http./rpc./db./messaging./exception. attributes. Other attributes are dropped; pass raw=true for the untouched OTel resourceSpans. " +
      "Among spans with status.code=STATUS_CODE_ERROR, the INNERMOST one (no other error span lists its spanId as parentSpanId) is where the failure originated; its ancestors only propagate it. " +
      "Only sampled requests have spans here — prefer an id whose gcp_logging_query sample_trace_sampled is true. " +
      'Empty result means that request was not sampled: routine, not a gap. Never cite it as evidence, root cause, or an observability gap, and never retry it — re-query gcp_logging_query with `trace="projects/<project>/traces/<id>"`, which returns that request\'s lines across every service regardless of sampling.',
    parameters: Type.Object({
      traceId: Type.String({
        description:
          "Hex trace ID, 16 or 32 chars. The 'projects/<project>/traces/<id>' form is accepted. Anything else is rejected without a query.",
      }),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Return untouched OTel resourceSpans with every attribute. Costs far more context and risks truncation on a wide trace — use only when a dropped attribute is the answer.",
        }),
      ),
    }),
    execute: guarded(async (args, tw) => {
      const a = args as { traceId: string; raw?: boolean };
      const traceId = normalizeTraceId(a.traceId ?? "");
      if (!traceId) {
        return textResult(
          `Rejected: ${JSON.stringify(a.traceId)} is not a trace ID. Pass 16 or 32 hex characters from a gcp_logging_query sample_trace. ` +
            `This tool cannot search by service, operation, or free text.`,
          true,
        );
      }
      const r = await getTrace(getClient(addr), {
        traceId,
        startTime: isoToTimestamp(tw.startISO()),
        endTime: isoToTimestamp(tw.endISO()),
      });
      for (const rs of (r.resourceSpans ?? []) as OtelResourceSpans[]) {
        for (const ss of rs.scopeSpans ?? []) {
          for (const s of ss.spans ?? []) {
            if (s.traceId) (s as any).traceId = toHex(s.traceId);
            if (s.spanId) (s as any).spanId = toHex(s.spanId);
            if (s.parentSpanId) (s as any).parentSpanId = toHex(s.parentSpanId);
          }
        }
      }
      if (a.raw) return textResult(r);
      return textResult({ trace_id: traceId, ...compactTrace((r.resourceSpans ?? []) as unknown[]) });
    }),
  };
}

export function jaegerTools(addr: string): SreTool[] {
  return [getTraceTool(addr)];
}
