import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import { alertTime } from "./shared.ts";

export function makePromInstantTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_prom_instant",
    label: "Prometheus instant query",
    description:
      "Evaluate a PromQL expression at a single point in time (defaults to alert time). " +
      'Use for checking current values, like `up{job="api"}`, `rate(http_requests_total[5m])`, ' +
      'or `kube_pod_container_resource_limits{resource="memory"}`.',
    parameters: Type.Object({
      query: Type.String({ description: "PromQL expression." }),
    }),
    ctx,
    run: async (params, signal) => {
      const result = await getClients().prom.instant({
        query: params.query,
        time: alertTime(ctx),
        ...(signal !== undefined && { signal }),
      });
      const store = ctx.evidence.prom_instant ?? {};
      store[params.query] = result;
      ctx.evidence.prom_instant = store;

      const summary =
        result.series.length === 0
          ? `No series returned for \`${params.query}\`.`
          : `Got ${result.series.length} series. First: ${JSON.stringify(result.series[0]?.value ?? null)}`;
      return {
        summary,
        details: { query: params.query, series: result.series.length },
      };
    },
  });
}

export function makePromRangeTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_prom_range",
    label: "Prometheus range query",
    description:
      "Evaluate a PromQL expression over a time range around the alert. Use to check trends — " +
      "CPU/memory usage, latency p99, request rates. Choose a step that gives you 30–60 data points.",
    parameters: Type.Object({
      query: Type.String(),
      lookback_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 180, default: 30 })),
      step_seconds: Type.Optional(Type.Number({ minimum: 15, maximum: 600, default: 30 })),
    }),
    ctx,
    run: async (params, signal) => {
      const end = alertTime(ctx);
      const lookback = params.lookback_minutes ?? 30;
      const start = new Date(end.getTime() - lookback * 60_000);
      const result = await getClients().prom.range({
        query: params.query,
        start,
        end,
        step: params.step_seconds ?? 30,
        ...(signal !== undefined && { signal }),
      });
      const store = ctx.evidence.prom_series ?? {};
      store[params.query] = result;
      ctx.evidence.prom_series = store;

      const summary =
        result.series.length === 0
          ? `No series returned for \`${params.query}\`.`
          : `Got ${result.series.length} series over ${lookback}m. ` +
            `First series has ${result.series[0]?.values.length ?? 0} samples.`;
      return {
        summary,
        details: {
          query: params.query,
          series: result.series.length,
          lookback_minutes: lookback,
        },
      };
    },
  });
}

export function makePromAlertRulesTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "get_prom_alert_rules",
    label: "Prometheus alert rules",
    description: "List Prometheus alerting rules and their current state (firing / pending / inactive).",
    parameters: Type.Object({}),
    ctx,
    run: async (_params, signal) => {
      const rules = await getClients().prom.alertRules(signal);
      ctx.evidence.prom_alert_rules = rules;

      const firing = rules.filter((r) => r.state === "firing").map((r) => r.name);
      const summary =
        rules.length === 0
          ? "No alert rules returned."
          : `Got ${rules.length} rules (${firing.length} firing). Firing: ${firing.join(", ") || "(none)"}`;
      return { summary, details: { count: rules.length } };
    },
  });
}
