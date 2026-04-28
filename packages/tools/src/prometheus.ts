import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import {
  alertEndTime,
  alertTime,
  IntentObject,
  intentWindowMinutes,
  LEAD_IN_MINUTES,
  recordEvidenceLink,
  setEvidenceMapEntry,
} from "./shared.ts";

export function makePromInstantTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_prom_instant",
    label: "Prometheus instant query",
    description:
      "Evaluate a PromQL expression at a single point in time (alert.fired_at). " +
      "For trends across the incident window use query_prom_range instead. " +
      'Use this for snapshot checks like `up{job="api"}`, `rate(http_requests_total[5m])`, ' +
      'or `kube_pod_container_resource_limits{resource="memory"}`.',
    parameters: Type.Object({
      query: Type.String({ description: "PromQL expression." }),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const result = await getClients().prom.instant({
        query: params.query,
        time: alertTime(ctx),
        ...(signal !== undefined && { signal }),
      });
      setEvidenceMapEntry(ctx, "prom_instant", params.query, result);
      recordEvidenceLink(ctx, "prom_instant", getClients().prom.uiUrl("graph", params.query));

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
      "Evaluate a PromQL expression over the incident window. Window starts " +
      "`lookback_minutes + 5` before alert.fired_at (5-min lead-in catches symptom " +
      "onset) and ends at the alert's close time, or wall-clock now if the alert " +
      "is still firing. Use to check trends — CPU/memory, latency p99, request rates. " +
      "Choose a step that gives you 30–60 data points.",
    parameters: Type.Object({
      query: Type.String(),
      lookback_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 180, default: 30 })),
      step_seconds: Type.Optional(Type.Number({ minimum: 15, maximum: 600, default: 30 })),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const fired = alertTime(ctx);
      const end = alertEndTime(ctx);
      const intentMinutes = intentWindowMinutes(params.intent?.time_window);
      const lookback = params.lookback_minutes ?? intentMinutes ?? 30;
      // Lead-in catches symptom onset before the evaluator tripped; the
      // window extends to alert close (or now) so post-fire peak/recovery
      // is always visible.
      const start = new Date(fired.getTime() - (lookback + LEAD_IN_MINUTES) * 60_000);
      const result = await getClients().prom.range({
        query: params.query,
        start,
        end,
        step: params.step_seconds ?? 30,
        ...(signal !== undefined && { signal }),
      });
      setEvidenceMapEntry(ctx, "prom_series", params.query, result);
      recordEvidenceLink(ctx, "prom_series", getClients().prom.uiUrl("graph", params.query));

      const totalMin = Math.round((end.getTime() - start.getTime()) / 60_000);
      const summary =
        result.series.length === 0
          ? `No series returned for \`${params.query}\`.`
          : `Got ${result.series.length} series over ${totalMin}m ` +
            `(start=${start.toISOString()} end=${end.toISOString()}). ` +
            `First series has ${result.series[0]?.values.length ?? 0} samples.`;
      return {
        summary,
        details: {
          query: params.query,
          series: result.series.length,
          lookback_minutes: lookback,
          window_start: start.toISOString(),
          window_end: end.toISOString(),
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
    parameters: Type.Object({
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (_params, signal) => {
      const rules = await getClients().prom.alertRules(signal);
      ctx.evidence.prom_alert_rules = rules;
      recordEvidenceLink(ctx, "prom_alert_rules", getClients().prom.uiUrl("alerts"));

      const firing = rules.filter((r) => r.state === "firing").map((r) => r.name);
      const summary =
        rules.length === 0
          ? "No alert rules returned."
          : `Got ${rules.length} rules (${firing.length} firing). Firing: ${firing.join(", ") || "(none)"}`;
      return { summary, details: { count: rules.length } };
    },
  });
}
