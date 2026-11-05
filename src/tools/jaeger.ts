import { resolve } from "node:path";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { sreTool, type SreTool } from "./types.ts";
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
  });
}

export function jaegerTools(addr: string): SreTool[] {
  return [getTraceTool(addr)];
}
