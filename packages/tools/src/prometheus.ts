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
  truncate,
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

/**
 * Discovery tool: list metric names known to the Prom server. Use BEFORE
 * writing PromQL when "no series returned" responses raise doubt about
 * whether the metric exists at all (vs labels being wrong vs workload
 * silent). Backed by `/api/v1/label/__name__/values` — same on vanilla
 * Prom + Google Managed Prometheus. Adapted from
 * pab1it0/prometheus-mcp-server `list_metrics`.
 */
export function makePromListMetricsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "list_prom_metrics",
    label: "List Prometheus metrics",
    description:
      "Return metric names known to the Prom server. Pass `contains` to narrow " +
      "(case-insensitive substring). Use this when query_prom_instant/range " +
      "returns no series and you suspect the metric name itself is wrong.",
    parameters: Type.Object({
      contains: Type.Optional(Type.String({ description: "Case-insensitive substring filter." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, default: 200 })),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const intentLimit = params.intent?.limit;
      const limit = params.limit ?? (intentLimit ? Math.min(intentLimit, 1000) : 200);
      const names = await getClients().prom.listMetrics({
        ...(params.contains !== undefined && { contains: params.contains }),
        limit,
        ...(signal !== undefined && { signal }),
      });
      ctx.evidence.prom_metrics = names;

      const summary =
        names.length === 0
          ? `No metric names matched${params.contains ? ` "${params.contains}"` : ""}.`
          : `Got ${names.length} metric name(s)${params.contains ? ` matching "${params.contains}"` : ""}. ` +
            `Sample: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`;
      return { summary, details: { count: names.length, contains: params.contains } };
    },
  });
}

/**
 * Discovery tool: per-metric metadata (type, help text, unit). Resolves
 * "is this a counter, gauge, or histogram?" before writing rate() over a
 * gauge. Backed by `/api/v1/metadata`. Adapted from
 * pab1it0/prometheus-mcp-server `get_metric_metadata`.
 */
export function makePromMetricMetadataTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "get_prom_metric_metadata",
    label: "Prometheus metric metadata",
    description:
      "Return type/help/unit for a metric. Counters need rate(), gauges don't, " +
      "histograms need histogram_quantile(). Call this when uncertain about a " +
      "metric's type before writing the PromQL.",
    parameters: Type.Object({
      metric: Type.Optional(
        Type.String({ description: "Specific metric name. Omit to fetch metadata for all metrics." }),
      ),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const md = await getClients().prom.metricMetadata({
        ...(params.metric !== undefined && { metric: params.metric }),
        perMetricLimit: 1,
        ...(signal !== undefined && { signal }),
      });
      ctx.evidence.prom_metric_metadata = md;

      const head = md
        .slice(0, 5)
        .map((m) => `${m.metric}=${m.type}${m.unit ? ` (${m.unit})` : ""}`)
        .join(", ");
      const summary =
        md.length === 0
          ? `No metadata returned${params.metric ? ` for ${params.metric}` : ""}.`
          : md.length === 1 && md[0]
            ? `${md[0].metric}: type=${md[0].type}${md[0].unit ? ` unit=${md[0].unit}` : ""}. ` +
              `help=${truncate(md[0].help, 160)}`
            : `Got ${md.length} metadata entries. Top: ${head}`;
      return { summary, details: { count: md.length, metric: params.metric } };
    },
  });
}

/**
 * Discovery tool: scrape target health (`/api/v1/targets`). Detects the
 * "Prom isn't scraping the workload" failure mode before blaming the
 * workload itself. Adapted from pab1it0/prometheus-mcp-server
 * `get_targets`.
 *
 * Note for Google Managed Prometheus: GMP does NOT expose /api/v1/targets
 * via the gateway. Calls will return an empty list there; that's expected
 * behaviour and surfaces in the summary rather than as an error.
 */
export function makePromTargetsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "get_prom_targets",
    label: "Prometheus scrape targets",
    description:
      "List Prometheus scrape targets and their health (up/down) with " +
      "lastError when failing. Use when prom queries return no data and you " +
      "need to confirm scraping is working at all. NOTE: Google Managed " +
      "Prometheus does not expose this endpoint — calls will return empty.",
    parameters: Type.Object({
      job: Type.Optional(Type.String({ description: "Filter to a single job label." })),
      state: Type.Optional(
        Type.Union([Type.Literal("active"), Type.Literal("dropped"), Type.Literal("any")], {
          default: "active",
        }),
      ),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const targets = await getClients().prom.targets({
        ...(params.job !== undefined && { job: params.job }),
        state: params.state ?? "active",
        ...(signal !== undefined && { signal }),
      });
      ctx.evidence.prom_targets = targets;

      const down = targets.filter((t) => t.health === "down");
      const downHead = down
        .slice(0, 3)
        .map((t) => `${t.job}/${t.instance}${t.lastError ? `: ${truncate(t.lastError, 120)}` : ""}`)
        .join(" | ");
      const summary =
        targets.length === 0
          ? `No targets returned${params.job ? ` for job=${params.job}` : ""}. ` +
            "(GMP gateways do not expose /api/v1/targets — empty result is expected there.)"
          : `Got ${targets.length} targets (${down.length} down). ${down.length > 0 ? `Down: ${downHead}` : "All up."}`;
      return { summary, details: { count: targets.length, down: down.length } };
    },
  });
}
