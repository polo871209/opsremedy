import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext, LogEntry } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import { IntentObject, intentWindowMinutes, windowAroundAlert } from "./shared.ts";

/**
 * Cheap discovery sweep so the LLM picks valid `resource.type` and label
 * values BEFORE writing a real `query_gcp_logs` filter. Avoids cargo-culting
 * `resource.type` from alert annotations (e.g. `prometheus_target`) and
 * blowing a tool call on a filter that will return zero rows.
 */
export function makeGcpDiscoverTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "discover_gcp_log_resources",
    label: "Discover GCP log resource scopes",
    description:
      "Run a small sample query against Cloud Logging in the alert window and " +
      "return the most common `resource.type` values, namespaces, pod/container " +
      "names, log names, and severity counts that actually exist.\n" +
      "Call this FIRST when you don't already know which `resource.type` or " +
      "labels carry the relevant logs. Use the returned values to build a " +
      "precise `query_gcp_logs` filter on the next step.\n" +
      "Time window is set by the program (around the alert). Do NOT add " +
      "timestamp predicates. The pre-filter is optional — leave it empty for a " +
      "broad sweep, or pass a coarse predicate like " +
      '`resource.labels.namespace_name="payments"` when you already know the ' +
      "namespace.",
    parameters: Type.Object({
      pre_filter: Type.Optional(
        Type.String({
          description:
            "Optional Cloud Logging filter to narrow the sample (e.g. " +
            'resource.labels.namespace_name="payments"). Leave empty for a ' +
            "broad sweep. Do NOT include timestamps; the program supplies the window.",
        }),
      ),
      sample_size: Type.Optional(
        Type.Number({
          minimum: 50,
          maximum: 500,
          default: 200,
          description: "How many recent entries to sample for aggregation.",
        }),
      ),
      time_window_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 180, default: 30 })),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const intentMinutes = intentWindowMinutes(params.intent?.time_window);
      const minutes = params.time_window_minutes ?? intentMinutes ?? 30;
      const window = windowAroundAlert(ctx, minutes);
      const sample = params.sample_size ?? 200;
      const filter = (params.pre_filter ?? "").trim();

      const entries = await getClients().gcp.search({
        filter,
        from: window.from,
        to: window.to,
        max: sample,
        ...(signal !== undefined && { signal }),
      });

      const agg = aggregate(entries);
      const windowStr = `${window.from.toISOString()}..${window.to.toISOString()}`;
      const filterStr = filter || "(none)";
      const head = `Sampled ${entries.length} entries in window ${windowStr}; pre_filter=${filterStr}`;
      const details = {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        pre_filter: filter,
        sampled: entries.length,
        ...agg,
      };

      if (entries.length === 0) {
        return {
          summary: `${head}. No logs in window. Try a broader pre_filter or check that logs are actually being ingested for this project.`,
          details,
        };
      }

      const hint = buildHint(agg);
      const lines = [
        head,
        `severities: ${formatTop(agg.severities, 6)}`,
        `resource.type (top 5): ${formatTop(agg.resourceTypes, 5)}`,
        `namespaces (top 5): ${formatTop(agg.namespaces, 5)}`,
        `pod_name (top 5): ${formatTop(agg.podNames, 5)}`,
        `container (top 5): ${formatTop(agg.containerNames, 5)}`,
        hint ? `hint: ${hint}` : "",
      ].filter(Boolean);

      return { summary: lines.join("\n"), details };
    },
  });
}

interface Aggregated {
  severities: Counter;
  resourceTypes: Counter;
  namespaces: Counter;
  podNames: Counter;
  containerNames: Counter;
}

type Counter = Array<{ value: string; count: number }>;

function aggregate(entries: LogEntry[]): Aggregated {
  const severities = new Map<string, number>();
  const resourceTypes = new Map<string, number>();
  const namespaces = new Map<string, number>();
  const podNames = new Map<string, number>();
  const containerNames = new Map<string, number>();

  for (const e of entries) {
    bump(severities, e.severity);
    if (e.resourceType) bump(resourceTypes, e.resourceType);
    const ns = e.resource?.namespace_name ?? e.labels?.namespace_name;
    if (ns) bump(namespaces, ns);
    const pod = e.resource?.pod_name ?? e.labels?.pod_name;
    if (pod) bump(podNames, pod);
    const container = e.resource?.container_name ?? e.labels?.container_name;
    if (container) bump(containerNames, container);
  }

  return {
    severities: rank(severities),
    resourceTypes: rank(resourceTypes),
    namespaces: rank(namespaces),
    podNames: rank(podNames),
    containerNames: rank(containerNames),
  };
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function rank(m: Map<string, number>): Counter {
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function formatTop(c: Counter, n: number): string {
  if (c.length === 0) return "(none)";
  return c
    .slice(0, n)
    .map((x) => `${x.value}=${x.count}`)
    .join(", ");
}

/**
 * Suggest a starter filter so the LLM does not have to guess. We only emit a
 * hint when the dominant resource.type is unambiguous; otherwise we stay
 * silent rather than mislead.
 */
function buildHint(s: Aggregated): string {
  const topType = s.resourceTypes[0];
  if (!topType) return "";
  const parts = [`resource.type="${topType.value}"`];
  const topNs = s.namespaces[0];
  if (topNs && topNs.count >= Math.ceil(topType.count / 4)) {
    parts.push(`resource.labels.namespace_name="${topNs.value}"`);
  }
  return parts.join(" AND ");
}
