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

export function makeGcpLogsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "query_gcp_logs",
    label: "Query GCP Cloud Logging",
    description:
      "Search GCP Cloud Logging around the alert time. " +
      'Prefer targeted filters (severity, resource.labels.pod_name, resource.labels.namespace_name, textPayload:"..."). ' +
      "Examples:\n" +
      '- severity>=ERROR AND resource.labels.pod_name="my-pod"\n' +
      '- resource.labels.namespace_name="my-ns" AND textPayload:"OOMKilled"',
    parameters: Type.Object({
      filter: Type.String({ description: "Cloud Logging filter expression." }),
      time_window_minutes: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 180,
          default: 30,
          description: "Minutes before the alert to include.",
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
        ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(e.severity),
      );
      const gcp = getClients().gcp;
      recordEvidenceLink(ctx, "gcp_logs", gcp.uiUrl(filter, false));
      recordEvidenceLink(ctx, "gcp_error_logs", gcp.uiUrl(filter, true));

      const errorCount = ctx.evidence.gcp_error_logs.length;
      const topMessages = entries
        .slice(0, 5)
        .map((e) => `[${e.severity}] ${truncate(e.textPreview, 200)}`)
        .join(" | ");

      const summary =
        entries.length === 0
          ? "No logs matched the filter in the window."
          : `Fetched ${entries.length} log entries (${errorCount} at ERROR+). Top: ${topMessages}`;

      return {
        summary,
        details: { filter, count: entries.length, errors: errorCount },
      };
    },
  });
}
