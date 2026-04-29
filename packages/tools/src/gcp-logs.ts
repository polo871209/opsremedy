import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import {
  appendEvidence,
  IntentObject,
  intentWindowMinutes,
  recordEvidenceLink,
  truncate,
  windowAroundAlert,
} from "./shared.ts";

const ERROR_SEVERITIES = new Set(["ERROR", "CRITICAL", "ALERT", "EMERGENCY"]);
const WARN_SEVERITIES = new Set(["WARNING"]);

export function makeGcpLogsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_gcp_logs",
    label: "Query GCP Cloud Logging",
    description:
      "Search GCP Cloud Logging across the incident window. The window is set by " +
      "the program (alert.fired_at - lead-in to alert.closed_at). Do NOT add " +
      "timestamp predicates to your filter.\n" +
      "BEFORE writing a filter: if you don't already know which `resource.type` " +
      "or labels carry the relevant logs, call `discover_gcp_log_resources` " +
      "first. It returns the actual top resource types, namespaces, pod names, " +
      "and severity counts in this window so you don't have to guess.\n" +
      "IMPORTANT: `resource.type` must be a Cloud Logging resource type, NOT the " +
      "alert's metric resource type. The alert's `annotations.resource_type` " +
      "(e.g. `prometheus_target`, `k8s_pod`, `gce_instance`) describes the metric " +
      "source and is usually NOT a valid logs resource type. For workload logs use " +
      '`resource.type="k8s_container"` (most common) or `k8s_pod`; for node-level ' +
      "logs use `k8s_node`. Filter further with `resource.labels.namespace_name`, " +
      "`resource.labels.pod_name`, `resource.labels.container_name`.\n" +
      "SEVERITY: don't restrict to ERROR by default. Many real incidents log at " +
      "WARNING (graceful-shutdown notices, retry warnings, istio access logs). " +
      "Start with `severity>=WARNING`; only narrow to `severity>=ERROR` after a " +
      "first pass. If a previous query returned entries with empty content, " +
      "retry without the severity filter so application INFO logs are included.\n" +
      "AFTER finding the failing pod's namespace/name from k8s tools, drill into " +
      "its container logs directly: " +
      '`resource.type="k8s_container" AND resource.labels.namespace_name="<ns>" ' +
      'AND resource.labels.pod_name="<pod>"`. The istio sidecar lives next to ' +
      'the app container; filter `container_name="<app>"` to skip mesh noise.\n' +
      'Prefer targeted filters (severity, resource.labels.pod_name, resource.labels.namespace_name, textPayload:"..."). ' +
      "Examples:\n" +
      '- resource.type="k8s_container" AND resource.labels.namespace_name="my-ns" AND severity>=WARNING\n' +
      '- resource.type="k8s_container" AND resource.labels.pod_name="my-pod" AND resource.labels.container_name="app"\n' +
      '- resource.type="k8s_container" AND resource.labels.namespace_name="my-ns" AND textPayload:"OOMKilled"',
    parameters: Type.Object({
      filter: Type.String({ description: "Cloud Logging filter expression." }),
      time_window_minutes: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 180,
          default: 30,
          description: "Minutes before alert.fired_at to include (a 5-min lead-in is added on top).",
        }),
      ),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 50 })),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      // Resolve intent fallbacks. Explicit params win; intent fills the gap.
      const intentMinutes = intentWindowMinutes(params.intent?.time_window);
      const minutes = params.time_window_minutes ?? intentMinutes ?? 30;
      const intentLimit = params.intent?.limit;
      const max = params.max_results ?? (intentLimit ? Math.min(intentLimit, 200) : 50);

      // Apply severity floor when intent.level is set and the user filter
      // doesn't already constrain severity. Simple substring guard avoids
      // double-filtering when the LLM already wrote `severity>=ERROR`.
      let filter = params.filter;
      if (params.intent?.level && !/severity\s*[>=<]/i.test(filter)) {
        filter = `(${filter}) AND severity>=${params.intent.level}`;
      }

      const window = windowAroundAlert(ctx, minutes);
      const entries = await getClients().gcp.search({
        filter,
        from: window.from,
        to: window.to,
        max,
        ...(signal !== undefined && { signal }),
      });

      appendEvidence(ctx, "gcp_logs", entries);
      // Re-derive the error-only view from the full set so it stays in sync
      // across multiple log queries within the same investigation.
      ctx.evidence.gcp_error_logs = (ctx.evidence.gcp_logs ?? []).filter((e) =>
        ERROR_SEVERITIES.has(e.severity),
      );
      const gcp = getClients().gcp;
      recordEvidenceLink(ctx, "gcp_logs", gcp.uiUrl(filter, false, window));
      recordEvidenceLink(ctx, "gcp_error_logs", gcp.uiUrl(filter, true, window));

      const errorCount = ctx.evidence.gcp_error_logs.length;
      const warnCount = entries.filter((e) => WARN_SEVERITIES.has(e.severity)).length;
      const topMessages = entries
        .slice(0, 5)
        .map((e) => `[${e.severity}] ${truncate(e.textPreview, 200)}`)
        .join(" | ");

      // Detect the case where every entry's textPreview is empty — common for
      // istio/envoy access logs whose jsonPayload has no `message` field. The
      // structured payload is still in evidence, but the LLM only sees the
      // summary line, so warn it explicitly so it knows to retry differently.
      const blankPreviews = entries.length > 0 && entries.every((e) => e.textPreview.length === 0);

      // Echo the effective filter and program-set window so the LLM can see
      // exactly what ran (and notice when its filter was wrong, e.g. picked
      // an alert metric resource_type that has no logs).
      const windowStr = `${window.from.toISOString()}..${window.to.toISOString()}`;
      const queryLine = `[query] filter=${JSON.stringify(filter)} window=${windowStr} order=desc max=${max}`;
      const counts = `${entries.length} log entries (${errorCount} at ERROR+, ${warnCount} at WARNING)`;
      let summary: string;
      if (entries.length === 0) {
        summary =
          `${queryLine}\nNo logs matched. If you guessed at resource.type or labels, call ` +
          "discover_gcp_log_resources to see what actually exists in this window before retrying. " +
          "Also try widening to severity>=WARNING — many incidents log warnings rather than errors.";
      } else if (blankPreviews) {
        summary =
          `${queryLine}\nFetched ${counts} but all textPreviews are empty (likely structured ` +
          "jsonPayload without a `message` field, e.g. istio access logs). Retry with a more " +
          "specific filter — narrow to the failing app's namespace/pod/container, drop the " +
          "severity floor (or set severity>=WARNING), or filter by a specific field like " +
          "`jsonPayload.response_code>=500`.";
      } else {
        summary = `${queryLine}\nFetched ${counts}. Top: ${topMessages}`;
      }

      return {
        summary,
        details: {
          filter,
          window: { from: window.from.toISOString(), to: window.to.toISOString() },
          count: entries.length,
          errors: errorCount,
          warnings: warnCount,
          blankPreviews,
        },
      };
    },
  });
}
