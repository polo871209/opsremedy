import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getClients } from "@opsremedy/clients";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import { appendEvidence, IntentObject, setEvidenceMapEntry, truncate } from "./shared.ts";

export function makeK8sListPodsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "k8s_get_pods",
    label: "List Kubernetes pods",
    description:
      "List pods in a namespace. Returns phase, ready, restart count, and lastTerminationReason. " +
      "Use when a pod-level alert fires to confirm the state of the affected workload.",
    parameters: Type.Object({
      namespace: Type.String(),
      label_selector: Type.Optional(Type.String({ description: "e.g. app=my-app" })),
      field_selector: Type.Optional(Type.String()),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const all = await getClients().k8s.listPods({
        namespace: params.namespace,
        ...(params.label_selector !== undefined && { labelSelector: params.label_selector }),
        ...(params.field_selector !== undefined && { fieldSelector: params.field_selector }),
        ...(signal !== undefined && { signal }),
      });
      const limit = params.intent?.limit;
      const pods = limit ? all.slice(0, limit) : all;
      appendEvidence(ctx, "k8s_pods", pods);

      const unhealthy = pods.filter((p) => !p.ready || p.phase !== "Running").length;
      const owners = [...new Set(pods.map((p) => p.owner).filter((o): o is string => !!o))];
      const summary =
        pods.length === 0
          ? `No pods found in ${params.namespace} matching selector.`
          : `Got ${pods.length} pods (${unhealthy} not ready). ` +
            `Phases: ${[...new Set(pods.map((p) => p.phase))].join(",")}. ` +
            (owners.length > 0 ? `Owners: ${owners.slice(0, 4).join(", ")}. ` : "") +
            `Notable: ${
              pods
                .filter((p) => p.lastTerminationReason)
                .slice(0, 3)
                .map((p) => `${p.name}:${p.lastTerminationReason}`)
                .join(", ") || "(none)"
            }`;
      return { summary, details: { count: pods.length, unhealthy } };
    },
  });
}

export function makeK8sDescribeTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "k8s_describe",
    label: "Describe Kubernetes object",
    description:
      "Equivalent of `kubectl describe`. Great for reading container statuses, resource limits, " +
      "events on a single object, and recent terminations (OOMKilled, Error, etc.).",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("pod"),
        Type.Literal("deployment"),
        Type.Literal("node"),
        Type.Literal("service"),
        Type.Literal("job"),
        Type.Literal("statefulset"),
      ]),
      name: Type.String(),
      namespace: Type.Optional(Type.String()),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const text = await getClients().k8s.describe({
        kind: params.kind,
        name: params.name,
        ...(params.namespace !== undefined && { namespace: params.namespace }),
        ...(signal !== undefined && { signal }),
      });
      const key = `${params.kind}/${params.name}${params.namespace ? `@${params.namespace}` : ""}`;
      setEvidenceMapEntry(ctx, "k8s_describe", key, text);
      return {
        summary: truncate(text, 400),
        details: { kind: params.kind, name: params.name, length: text.length },
      };
    },
  });
}

export function makeK8sEventsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "k8s_get_events",
    label: "Kubernetes events",
    description:
      "List recent events in a namespace. Surface scheduling failures, OOMKilled, " +
      "BackOff, FailedMount, ProvisioningFailed, Unhealthy. Pass `object_name` " +
      "(and optional `object_kind`) to scope events to one resource — preferred " +
      "over hand-writing `field_selector`. Use `field_selector` only for advanced " +
      "selectors not covered by object_*.",
    parameters: Type.Object({
      namespace: Type.String(),
      object_name: Type.Optional(
        Type.String({
          description: "Filter to events whose involvedObject.name matches.",
        }),
      ),
      object_kind: Type.Optional(
        Type.String({
          description: "Filter to events whose involvedObject.kind matches (Pod, Deployment, ...).",
        }),
      ),
      field_selector: Type.Optional(
        Type.String({
          description: "Raw field selector. Ignored when object_name is set.",
        }),
      ),
      intent: Type.Optional(IntentObject),
    }),
    ctx,
    run: async (params, signal) => {
      const fieldSelector = buildEventFieldSelector(params);
      const all = await getClients().k8s.events({
        namespace: params.namespace,
        ...(fieldSelector !== undefined && { fieldSelector }),
        ...(signal !== undefined && { signal }),
      });
      const limit = params.intent?.limit;
      const events = limit ? all.slice(0, limit) : all;
      appendEvidence(ctx, "k8s_events", events);

      const warnings = events.filter((e) => e.type === "Warning").length;
      const topReasons = [...new Set(events.map((e) => e.reason))].slice(0, 5).join(", ");
      const scope = params.object_name
        ? `${params.object_kind ? `${params.object_kind}/` : ""}${params.object_name} in ${params.namespace}`
        : `namespace ${params.namespace}`;
      const summary =
        events.length === 0
          ? `No events in ${scope}.`
          : `Got ${events.length} events for ${scope} (${warnings} warnings). Reasons: ${topReasons}`;
      return { summary, details: { count: events.length, warnings, fieldSelector } };
    },
  });
}

function buildEventFieldSelector(params: {
  object_name?: string;
  object_kind?: string;
  field_selector?: string;
}): string | undefined {
  if (params.object_name) {
    const parts = [`involvedObject.name=${params.object_name}`];
    if (params.object_kind) parts.push(`involvedObject.kind=${params.object_kind}`);
    return parts.join(",");
  }
  return params.field_selector;
}

export function makeK8sPodLogsTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "k8s_pod_logs",
    label: "Kubernetes pod logs",
    description:
      "Tail container logs for a pod. Use `previous: true` to fetch logs from the previous " +
      "container instance when the current one just restarted (common for CrashLoopBackOff).",
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
      const intentLimit = params.intent?.limit;
      const lines = await getClients().k8s.podLogs({
        namespace: params.namespace,
        pod: params.pod,
        ...(params.container !== undefined && { container: params.container }),
        tailLines: params.tail_lines ?? (intentLimit ? Math.min(intentLimit, 500) : 100),
        ...(params.previous !== undefined && { previous: params.previous }),
        ...(signal !== undefined && { signal }),
      });
      const key = `${params.namespace}/${params.pod}${params.container ? `/${params.container}` : ""}`;
      setEvidenceMapEntry(ctx, "k8s_pod_logs", key, lines);

      const tail = lines
        .slice(-5)
        .map((l) => truncate(l, 160))
        .join("\n");
      const summary =
        lines.length === 0
          ? `No log lines returned for ${key}.`
          : `Got ${lines.length} lines. Last 5:\n${tail}`;
      return { summary, details: { count: lines.length } };
    },
  });
}
