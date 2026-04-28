import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import {
  alertEndTime,
  alertTime,
  appendEvidence,
  IntentObject,
  intentWindowMinutes,
  LEAD_IN_MINUTES,
  recordEvidenceLink,
} from "./shared.ts";

/**
 * Compute the lookback the Jaeger client needs so the resulting window is
 * `[fired_at - lookbackMinutes - LEAD_IN, alertEnd]`. Jaeger's API takes
 * (endTime, lookback); we expand lookback to cover the gap from fired_at
 * to alertEnd plus the user's requested lookback plus the 5-min lead-in.
 */
function jaegerWindow(
  ctx: InvestigationContext,
  lookbackMinutes: number,
): {
  endTime: Date;
  lookbackMinutes: number;
} {
  const fired = alertTime(ctx);
  const end = alertEndTime(ctx);
  const elapsedMin = Math.max(0, Math.ceil((end.getTime() - fired.getTime()) / 60_000));
  return {
    endTime: end,
    lookbackMinutes: lookbackMinutes + LEAD_IN_MINUTES + elapsedMin,
  };
}

export function makeJaegerTracesTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_jaeger_traces",
    label: "Query Jaeger traces",
    description:
      "Find traces for a service across the incident window: from " +
      "`lookback_minutes + 5` before alert.fired_at to the alert's close time " +
      "(or now if still firing). Optionally filter by operation or minimum duration. " +
      "Use to find slow or errored spans that coincided with the alert.",
    parameters: Type.Object({
      service: Type.String({ description: "Jaeger service name." }),
      operation: Type.Optional(Type.String()),
      min_duration_ms: Type.Optional(Type.Number({ minimum: 0 })),
      lookback_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 360, default: 30 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 20 })),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const intentMinutes = intentWindowMinutes(params.intent?.time_window);
      const intentLimit = params.intent?.limit;
      const userLookback = params.lookback_minutes ?? intentMinutes ?? 30;
      const window = jaegerWindow(ctx, userLookback);
      const traces = await getClients().jaeger.findTraces({
        service: params.service,
        ...(params.operation !== undefined && { operation: params.operation }),
        ...(params.min_duration_ms !== undefined && { minDurationMs: params.min_duration_ms }),
        lookbackMinutes: window.lookbackMinutes,
        limit: params.limit ?? (intentLimit ? Math.min(intentLimit, 50) : 20),
        endTime: window.endTime,
        ...(signal !== undefined && { signal }),
      });
      appendEvidence(ctx, "jaeger_traces", traces);
      recordEvidenceLink(ctx, "jaeger_traces", getClients().jaeger.uiUrl("search", params.service));

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
      "List upstream/downstream services across the incident window: from " +
      "`lookback_minutes + 5` before alert.fired_at to the alert's close time " +
      "(or now if still firing). " +
      "Useful for narrowing the failure domain (upstream producer vs downstream consumer).",
    parameters: Type.Object({
      service: Type.String(),
      lookback_minutes: Type.Optional(Type.Number({ minimum: 5, maximum: 1440, default: 60 })),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const intentMinutes = intentWindowMinutes(params.intent?.time_window);
      const userLookback = params.lookback_minutes ?? intentMinutes ?? 60;
      const window = jaegerWindow(ctx, userLookback);
      const deps = await getClients().jaeger.serviceDependencies({
        service: params.service,
        lookbackMinutes: window.lookbackMinutes,
        endTime: window.endTime,
        ...(signal !== undefined && { signal }),
      });
      appendEvidence(ctx, "jaeger_service_deps", deps);
      recordEvidenceLink(ctx, "jaeger_service_deps", getClients().jaeger.uiUrl("dependencies"));

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
