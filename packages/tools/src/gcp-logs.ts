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
      "Search Cloud Logging in alert window. Window set by program — do NOT add " +
      "timestamp predicates.\n" +
      "Don't know which `resource.type` or labels carry the logs? Call " +
      "`discover_gcp_log_resources` first.\n" +
      "Hard rule: `resource.type` must be a Cloud Logging resource type, NOT the " +
      "alert's metric resource type. `annotations.resource_type` (e.g. " +
      "`prometheus_target`, `k8s_pod`, `gce_instance`) is metric-side; usually " +
      'NOT a valid logs type. Workload logs → `resource.type="k8s_container"` ' +
      "(common) or `k8s_pod`. Node-level → `k8s_node`. Narrow with " +
      "`resource.labels.namespace_name`, `pod_name`, `container_name`.\n" +
      "Severity: don't restrict to ERROR by default. Real incidents often log at " +
      "WARNING (graceful-shutdown, retry, istio access). Start `severity>=WARNING`; " +
      "narrow to ERROR after first pass. Empty content from previous query → drop " +
      "severity filter so INFO logs included.\n" +
      "After k8s tools surface the failing pod, drill straight into its container: " +
      '`resource.type="k8s_container" AND resource.labels.namespace_name="<ns>" ' +
      'AND resource.labels.pod_name="<pod>"`. Istio sidecar sits next to app; ' +
      'add `container_name="<app>"` to skip mesh noise.\n' +
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
          description: "Minutes before alert.fired_at to include (5-min lead-in added on top).",
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
          `${queryLine}\nNo logs matched. Guessed resource.type/labels? Call ` +
          "discover_gcp_log_resources first. Also try severity>=WARNING — many " +
          "incidents log warnings, not errors.";
      } else if (blankPreviews) {
        summary =
          `${queryLine}\nFetched ${counts} but all textPreviews empty (structured ` +
          "jsonPayload without `message` field, e.g. istio access logs). Retry with " +
          "tighter filter — narrow to failing app's namespace/pod/container, drop " +
          "severity floor (or use severity>=WARNING), or pin a field like " +
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
