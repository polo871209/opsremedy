import { Type } from "@earendil-works/pi-ai";
import type { SreTool } from "./types.ts";
import * as k8s from "@kubernetes/client-node";
import { textResult, guarded } from "./result.ts";

let _core: k8s.CoreV1Api | undefined;
let _apps: k8s.AppsV1Api | undefined;
function init() {
  if (_core) return;
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  _core = kc.makeApiClient(k8s.CoreV1Api);
  _apps = kc.makeApiClient(k8s.AppsV1Api);
}

const STATE_MSG_MAX = 160;
function containerState(s: k8s.V1ContainerState | undefined) {
  if (!s) return undefined;
  const [phase, body] = s.waiting
    ? ["waiting", s.waiting as { reason?: string; message?: string }]
    : s.terminated
      ? ["terminated", s.terminated as { reason?: string; message?: string }]
      : ["running", undefined];
  if (!body) return { phase };
  const msg = body.message?.slice(0, STATE_MSG_MAX);
  return { phase, reason: body.reason, message: msg };
}

function trimPod(p: k8s.V1Pod) {
  const status = p.status ?? {};
  return {
    name: p.metadata?.name,
    namespace: p.metadata?.namespace,
    phase: status.phase,
    ready: status.containerStatuses?.every((c) => c.ready) ?? false,
    restarts: status.containerStatuses?.reduce((n, c) => n + (c.restartCount ?? 0), 0) ?? 0,
    node: p.spec?.nodeName,
    startTime: status.startTime,
    containers: status.containerStatuses?.map((c) => ({
      name: c.name,
      ready: c.ready,
      restartCount: c.restartCount,
      state: containerState(c.state),
    })),
    conditions: status.conditions?.map((c) => ({ type: c.type, status: c.status, reason: c.reason })),
    labels: p.metadata?.labels,
  };
}

function getPodsTool(appNamespace: string): SreTool {
  return {
    name: "k8s_get_pods",
    cheap: false,
    retry: true,
    description:
      "List pods in a namespace with optional label/field selectors. " +
      "Returns trimmed status only (phase, ready, restarts, node, startTime, containers, conditions, labels) — no PodSpec. " +
      "Container images live in k8s_rollout_history, live requests/limits in k8s_get_deployments; env vars are exposed by no tool here, so read them from source instead of re-listing pods.",

    parameters: Type.Object({
      namespace: Type.Optional(
        Type.String({
          description:
            `Application workloads run in '${appNamespace}'; pass it. Omitting scans every namespace and mostly returns platform pods.`,
        }),
      ),
      labelSelector: Type.Optional(Type.String({ description: "e.g. app=foo,env=prod" })),
      fieldSelector: Type.Optional(Type.String({ description: "e.g. status.phase!=Running" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 30 })),
    }),
    execute: guarded(async (args) => {
      init();
      const a = args as { namespace?: string; labelSelector?: string; fieldSelector?: string; limit?: number };
      const res = a.namespace
        ? await _core!.listNamespacedPod({
            namespace: a.namespace,
            labelSelector: a.labelSelector,
            fieldSelector: a.fieldSelector,
            limit: a.limit ?? 30,
          })
        : await _core!.listPodForAllNamespaces({
            labelSelector: a.labelSelector,
            fieldSelector: a.fieldSelector,
            limit: a.limit ?? 30,
          });
      return textResult({ count: res.items.length, pods: res.items.map(trimPod) });
    }),
  };
}

// Line-level window clamp. The kubelet log API bounds only the START of the
// stream (sinceSeconds), so the end is enforced here against the RFC3339 prefix
// that timestamps=true puts on every line.
const DEFAULT_TAIL = 100;

function lineMs(line: string): number | undefined {
  const sp = line.indexOf(" ");
  if (sp <= 0) return undefined;
  const ms = Date.parse(line.slice(0, sp));
  return Number.isNaN(ms) ? undefined : ms;
}

function windowLines(
  text: string,
  endMs: number | undefined,
  tail: number,
): { lines: string[]; dropped: number; truncated: boolean } {
  let lines = text.split("\n").filter((l) => l.length > 0);
  let dropped = 0;
  if (endMs !== undefined) {
    const kept = lines.filter((l) => {
      const ms = lineMs(l);
      return ms === undefined || ms < endMs;
    });
    dropped = lines.length - kept.length;
    lines = kept;
  }
  const truncated = lines.length > tail;
  return { lines: truncated ? lines.slice(-tail) : lines, dropped, truncated };
}

function podLogsTool(): SreTool {
  return {
    name: "k8s_pod_logs",
    cheap: false,
    retry: true,
    description:
      "Tail one pod's live log buffer, clamped to the alert window, one RFC3339 timestamp per line. " +
      "Raw lines, no dedupe or aggregation — for a single suspect pod, or previous=true for a crash the pod did not survive. " +
      "Anything cross-service, aggregated, or older than the current buffer belongs to gcp_logging_query.",
    parameters: Type.Object({
      namespace: Type.String(),
      name: Type.String({ description: "Pod name" }),
      container: Type.Optional(Type.String({ description: "Required when the pod runs several containers" })),
      tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: DEFAULT_TAIL })),
      previous: Type.Optional(
        Type.Boolean({
          description:
            "Logs of the instance before the last restart, the only way to see a CrashLoopBackOff/OOMKill. Not window-clamped: a terminated buffer may predate the window entirely.",
        }),
      ),
      startTime: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec. Clamped to the alert window." })),
      endTime: Type.Optional(Type.String({ description: "ISO8601 or unix-ms/sec. Clamped to the alert window." })),
    }),
    execute: guarded(async (args, tw) => {
      init();
      const a = args as {
        namespace: string;
        name: string;
        container?: string;
        tail?: number;
        previous?: boolean;
        startTime?: string;
        endTime?: string;
      };
      const win = tw.clamp({ startTime: a.startTime, endTime: a.endTime });
      const tail = a.tail ?? DEFAULT_TAIL;
      const now = Date.now();
      const clamped = !a.previous;
      const endsInPast = win.endMs < now - 5_000;
      // Server-side tailLines runs before the end filter, so on a closed window a
      // chatty pod's last N lines can all fall after it. Over-fetch, then re-trim.
      const fetchLines = clamped && endsInPast ? Math.min(5000, tail * 20) : tail;
      const res = await _core!.readNamespacedPodLog({
        namespace: a.namespace,
        name: a.name,
        container: a.container,
        tailLines: fetchLines,
        previous: a.previous,
        timestamps: true,
        sinceSeconds: clamped ? Math.max(1, Math.ceil((now - win.startMs) / 1000)) : undefined,
      });
      const text = typeof res === "string" ? res : JSON.stringify(res);
      const { lines, dropped, truncated } = windowLines(text, clamped && endsInPast ? win.endMs : undefined, tail);
      return textResult({
        pod: a.name,
        namespace: a.namespace,
        container: a.container,
        window: a.previous ? "unclamped (previous instance)" : `${win.startISO} → ${win.endISO}`,
        lines: lines.length,
        dropped_after_window: dropped || undefined,
        truncated_older_lines: truncated || undefined,
        logs: lines.join("\n"),
      });
    }),
  };
}

function eventsTool(): SreTool {
  return {
    name: "k8s_get_events",
    cheap: false,
    retry: true,
    description:
      "Recent cluster events (OOMKilled, evictions, scheduling and probe failures) — the fastest read on whether a fault is infrastructure rather than application. " +
      "NOT window-clamped, and the cluster retains only ~1h: an older alert window returns events that POSTDATE it, and a symptom older than ~1h has none left. " +
      "Check each lastTimestamp against the window before citing an event as onset evidence.",
    parameters: Type.Object({
      namespace: Type.Optional(Type.String({ description: "Omit for all namespaces" })),
      type: Type.Optional(
        Type.Union([Type.Literal("Warning"), Type.Literal("Normal"), Type.Literal("All")], { default: "Warning" }),
      ),
      involvedObjectName: Type.Optional(Type.String({ description: "Pod / deployment / service name" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    }),
    execute: guarded(async (args) => {
      init();
      const a = args as {
        namespace?: string;
        type?: "Warning" | "Normal" | "All";
        involvedObjectName?: string;
        limit?: number;
      };
      const sel: string[] = [];
      if (a.type && a.type !== "All") sel.push(`type=${a.type}`);
      if (a.involvedObjectName) sel.push(`involvedObject.name=${a.involvedObjectName}`);
      const fieldSelector = sel.join(",") || undefined;
      const res = a.namespace
        ? await _core!.listNamespacedEvent({ namespace: a.namespace, fieldSelector })
        : await _core!.listEventForAllNamespaces({ fieldSelector });
      const items = res.items
        .map((ev) => ({
          lastTimestamp: ev.lastTimestamp ?? ev.eventTime ?? ev.metadata?.creationTimestamp,
          type: ev.type,
          reason: ev.reason,
          object: `${ev.involvedObject?.kind}/${ev.involvedObject?.name}`,
          namespace: ev.involvedObject?.namespace ?? ev.metadata?.namespace,
          message: ev.message,
          count: ev.count,
        }))
        .sort((a, b) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
        .slice(0, a.limit ?? 50);
      return textResult({ count: items.length, events: items });
    }),
  };
}

function getDeploymentsTool(appNamespace: string): SreTool {
  return {
    name: "k8s_get_deployments",
    cheap: false,
    retry: true,
    description:
      "Deployment replica health (replicas/available/ready/updated, conditions) + selector — use it to tell 'pods missing' from 'pods unhealthy', and to get the selector for k8s_get_pods. " +
      "Also returns each container's live cpu/memory requests and limits: the number to compare an OOMKill or a heap ceiling against. " +
      `ALWAYS pass namespace ('${appNamespace}' for application workloads) plus a labelSelector: an unscoped list is mostly platform workloads and huge.`,
    parameters: Type.Object({
      namespace: Type.Optional(Type.String({ description: `Application workloads run in '${appNamespace}'` })),
      labelSelector: Type.Optional(Type.String({ description: "e.g. app=foo" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 30 })),
    }),
    execute: guarded(async (args) => {
      init();
      const a = args as { namespace?: string; labelSelector?: string; limit?: number };
      const res = a.namespace
        ? await _apps!.listNamespacedDeployment({
            namespace: a.namespace,
            labelSelector: a.labelSelector,
            limit: a.limit ?? 30,
          })
        : await _apps!.listDeploymentForAllNamespaces({ labelSelector: a.labelSelector, limit: a.limit ?? 30 });
      const items = res.items.map((d) => ({
        name: d.metadata?.name,
        namespace: d.metadata?.namespace,
        replicas: d.status?.replicas,
        available: d.status?.availableReplicas,
        ready: d.status?.readyReplicas,
        updated: d.status?.updatedReplicas,
        conditions: d.status?.conditions?.map((c) => ({ type: c.type, status: c.status, reason: c.reason })),
        selector: d.spec?.selector?.matchLabels,
        containers: d.spec?.template?.spec?.containers?.map((c) => ({
          name: c.name,
          requests: c.resources?.requests,
          limits: c.resources?.limits,
        })),
      }));
      return textResult({ count: items.length, deployments: items });
    }),
  };
}

function rolloutHistoryTool(): SreTool {
  return {
    name: "k8s_rollout_history",
    cheap: false,
    retry: true,
    description:
      "Deployment revision history, newest first: revision, creationTimestamp, replicas/ready, container images. " +
      "The check for a deploy-induced cause: compare a revision's creationTimestamp against symptom onset. Also the only source of the running image tag.",
    parameters: Type.Object({
      namespace: Type.String(),
      name: Type.String({ description: "Deployment name" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
    }),
    execute: guarded(async (args) => {
      init();
      const a = args as { namespace: string; name: string; limit?: number };
      const dep = await _apps!.readNamespacedDeployment({ namespace: a.namespace, name: a.name });
      const uid = dep.metadata?.uid;
      const selector = dep.spec?.selector?.matchLabels;
      const labelSelector = selector
        ? Object.entries(selector)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : undefined;
      const rs = await _apps!.listNamespacedReplicaSet({ namespace: a.namespace, labelSelector });
      const owned = rs.items.filter((r) => r.metadata?.ownerReferences?.some((o) => o.uid === uid));
      const revisions = owned
        .map((r) => ({
          revision: Number(r.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
          creationTimestamp: r.metadata?.creationTimestamp,
          replicas: r.status?.replicas ?? 0,
          ready: r.status?.readyReplicas ?? 0,
          images: r.spec?.template?.spec?.containers?.map((c) => c.image).filter(Boolean) ?? [],
        }))
        .sort((x, y) => y.revision - x.revision)
        .slice(0, a.limit ?? 10);
      return textResult({
        deployment: a.name,
        namespace: a.namespace,
        currentRevision: dep.metadata?.annotations?.["deployment.kubernetes.io/revision"],
        count: revisions.length,
        revisions,
      });
    }),
  };
}

export function kubernetesTools(appNamespace: string): SreTool[] {
  return [
    getPodsTool(appNamespace),
    podLogsTool(),
    eventsTool(),
    getDeploymentsTool(appNamespace),
    rolloutHistoryTool(),
  ];
}
