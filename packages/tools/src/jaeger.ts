import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import { appendEvidence } from "./shared.ts";

export function makeJaegerTracesTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_jaeger_traces",
    label: "Query Jaeger traces",
    description:
      "Find recent traces for a service, optionally filtered by operation or minimum duration. " +
      "Use to find slow or errored spans when latency or error-rate alerts fire.",
    parameters: Type.Object({
      service: Type.String({ description: "Jaeger service name." }),
      operation: Type.Optional(Type.String()),
      min_duration_ms: Type.Optional(Type.Number({ minimum: 0 })),
      lookback_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 360, default: 30 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 20 })),
    }),
    ctx,
    run: async (params, signal) => {
      const traces = await getClients().jaeger.findTraces({
        service: params.service,
        ...(params.operation !== undefined && { operation: params.operation }),
        ...(params.min_duration_ms !== undefined && { minDurationMs: params.min_duration_ms }),
        lookbackMinutes: params.lookback_minutes ?? 30,
        limit: params.limit ?? 20,
        ...(signal !== undefined && { signal }),
      });
      appendEvidence(ctx, "jaeger_traces", traces);

      const errored = traces.filter((t) => t.hasError).length;
      const slowest = traces.reduce((a, b) => (a && a.durationMs > b.durationMs ? a : b), traces[0]);
      const summary =
        traces.length === 0
          ? `No traces for service=${params.service} in the window.`
          : `Got ${traces.length} traces (${errored} errored). Slowest: ${
              slowest?.durationMs ?? 0
            }ms on ${slowest?.rootOperation ?? "?"}`;
      return {
        summary,
        details: { count: traces.length, errored },
      };
    },
  });
}

export function makeJaegerDepsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "get_jaeger_service_deps",
    label: "Jaeger service dependencies",
    description:
      "List upstream/downstream services that called or were called by the given service. " +
      "Useful for narrowing the failure domain (upstream producer vs downstream consumer).",
    parameters: Type.Object({
      service: Type.String(),
      lookback_minutes: Type.Optional(Type.Number({ minimum: 5, maximum: 1440, default: 60 })),
    }),
    ctx,
    run: async (params, signal) => {
      const deps = await getClients().jaeger.serviceDependencies({
        service: params.service,
        lookbackMinutes: params.lookback_minutes ?? 60,
        ...(signal !== undefined && { signal }),
      });
      appendEvidence(ctx, "jaeger_service_deps", deps);

      const summary =
        deps.length === 0
          ? `No dependencies found for ${params.service}.`
          : `Got ${deps.length} edges. Top: ${deps
              .slice(0, 5)
              .map((d) => `${d.parent}→${d.child} (${d.callCount})`)
              .join(", ")}`;
      return { summary, details: { count: deps.length } };
    },
  });
}
