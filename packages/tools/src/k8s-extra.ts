import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { EventSummary, InvestigationContext, PodSummary } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import { appendEvidence, IntentObject, setEvidenceMapEntry, truncate } from "./shared.ts";

/**
 * Cheap cluster context: node health summary + namespace list. Use early
 * in an investigation when the alert namespace isn't obvious or when you
 * need to confirm the cluster itself is reachable. Adapted from
 * k8sgpt-ai/k8sgpt MCP `cluster-info` tool.
 */
export function makeK8sClusterInfoTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "k8s_cluster_info",
    label: "Kubernetes cluster info",
    description:
      "Return cluster-level facts: node count + ready count, and the list of " +
      "namespaces. Cheap context for routing later tool calls (e.g. confirming " +
      "the alert's namespace exists) and detecting node-level outages.",
    parameters: Type.Object({
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (_params, signal) => {
      const info = await getClients().k8s.clusterInfo(signal);
      const summary =
        `Nodes: ${info.nodes.ready}/${info.nodes.total} ready. ` +
        `Namespaces (${info.namespaces.length}): ${info.namespaces.slice(0, 12).join(", ")}` +
        (info.namespaces.length > 12 ? ", …" : "");
      return { summary, details: info };
    },
  });
}

/**
 * One-shot triage of a single failing pod. Replaces the common 3-call
 * sequence (k8s_get_pods → k8s_describe → k8s_get_events → k8s_pod_logs)
 * with one parallel fetch. Use when you already know the pod name.
 *
 * Populates k8s_pods (summary), k8s_describe (key=pod/<name>@<ns>),
 * k8s_events (filtered to involvedObject.name=<name>), and k8s_pod_logs
 * (key=<ns>/<name>) in one call.
 */
export function makeK8sTriagePodTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "k8s_triage_pod",
    label: "Triage one Kubernetes pod",
    description:
      "Fetch describe + events + tail of logs for a single pod in one parallel " +
      "call. Use when k8s_get_pods (or the alert) names a specific failing pod " +
      "— faster than calling k8s_describe, k8s_get_events, and k8s_pod_logs " +
      "separately. Pass `previous: true` to read logs from the prior container " +
      "instance (CrashLoopBackOff).",
    parameters: Type.Object({
      namespace: Type.String(),
      pod: Type.String(),
      container: Type.Optional(Type.String()),
      tail_lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 100 })),
      previous: Type.Optional(Type.Boolean()),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const k8s = getClients().k8s;
      const intentLimit = params.intent?.limit;
      const tail = params.tail_lines ?? (intentLimit ? Math.min(intentLimit, 500) : 100);

      const [pods, describe, events, logs] = await Promise.all([
        k8s.listPods({
          namespace: params.namespace,
          fieldSelector: `metadata.name=${params.pod}`,
          ...(signal !== undefined && { signal }),
        }),
        k8s
          .describe({
            kind: "pod",
            name: params.pod,
            namespace: params.namespace,
            ...(signal !== undefined && { signal }),
          })
          .catch((err: unknown) => `(describe failed: ${(err as Error).message})`),
        k8s.events({
          namespace: params.namespace,
          fieldSelector: `involvedObject.name=${params.pod}`,
          ...(signal !== undefined && { signal }),
        }),
        k8s
          .podLogs({
            namespace: params.namespace,
            pod: params.pod,
            ...(params.container !== undefined && { container: params.container }),
            tailLines: tail,
            ...(params.previous !== undefined && { previous: params.previous }),
            ...(signal !== undefined && { signal }),
          })
          .catch(() => [] as string[]),
      ]);

      // Persist to evidence using the same keys the dedicated tools use, so
      // downstream validators and renderers don't need to know about triage.
      if (pods.length > 0) appendEvidence(ctx, "k8s_pods", pods);
      const describeKey = `pod/${params.pod}@${params.namespace}`;
      setEvidenceMapEntry(ctx, "k8s_describe", describeKey, describe);
      if (events.length > 0) appendEvidence(ctx, "k8s_events", events);
      const logKey = `${params.namespace}/${params.pod}${params.container ? `/${params.container}` : ""}`;
      setEvidenceMapEntry(ctx, "k8s_pod_logs", logKey, logs);

      const summary = renderTriageSummary({
        ns: params.namespace,
        pod: params.pod,
        pods,
        events,
        logs,
      });
      return {
        summary,
        details: {
          pod: params.pod,
          namespace: params.namespace,
          events: events.length,
          logs: logs.length,
          describe_chars: describe.length,
        },
      };
    },
  });
}

function renderTriageSummary(args: {
  ns: string;
  pod: string;
  pods: PodSummary[];
  events: EventSummary[];
  logs: string[];
}): string {
  const head = args.pods[0];
  const headLine = head
    ? `pod=${args.ns}/${args.pod} phase=${head.phase} ready=${head.ready} restarts=${head.restarts}` +
      (head.lastTerminationReason ? ` lastTerm=${head.lastTerminationReason}` : "") +
      (head.owner ? ` owner=${head.owner}` : "")
    : `pod=${args.ns}/${args.pod} not found in cluster`;

  const warnings = args.events.filter((e) => e.type === "Warning");
  const topEvents = warnings
    .slice(0, 3)
    .map((e) => `${e.reason}: ${truncate(e.message, 120)}`)
    .join(" | ");
  const eventLine = warnings.length === 0 ? "events: none" : `events(${warnings.length}W): ${topEvents}`;

  const logTail = args.logs
    .slice(-3)
    .map((l) => truncate(l, 160))
    .join("\n");
  const logLine = args.logs.length === 0 ? "logs: none" : `logs(${args.logs.length}):\n${logTail}`;

  return [headLine, eventLine, logLine].join("\n");
}
