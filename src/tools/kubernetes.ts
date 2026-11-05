import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { sreTool, type SreTool } from "./types.ts";
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

export function k8sClients(): { core: k8s.CoreV1Api; apps: k8s.AppsV1Api } {
  init();
  return { core: _core!, apps: _apps! };
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
  return sreTool({
    name: "k8s_get_pods",
    cheap: false,
    retry: true,
    description:
      "List pods with their status only: phase, readiness, restarts, node, container states, conditions and labels. " +
      "Images come from k8s_list_images, and requests and limits from k8s_get_deployments. No tool reads env vars.",
    parameters: obj({
      namespace: opt(
        str({
          description: `Application workloads run in '${appNamespace}'. Without it, the list holds mostly platform pods.`,
        }),
      ),
      labelSelector: opt(str({ description: "e.g. app=foo,env=prod" })),
      fieldSelector: opt(str({ description: "e.g. status.phase!=Running" })),
      limit: opt(int({ minimum: 1, maximum: 200, default: 30 })),
    }),
    execute: guarded(async (a) => {
      init();
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
  });
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
  return sreTool({
    name: "k8s_pod_logs",
    cheap: false,
    retry: true,
    description:
      "Tail the live log buffer of one suspect pod in the alert window, as raw timestamped lines. " +
      "For cross-service logs, grouped logs or logs older than the buffer, use gcp_logging_query.",
    parameters: obj({
      namespace: str(),
      name: str({ description: "Pod name" }),
      container: opt(str({ description: "Required when the pod runs several containers" })),
      tail: opt(int({ minimum: 1, maximum: 500, default: DEFAULT_TAIL })),
      previous: opt(
        bool({
          description:
            "Logs of the container before its last restart, for a CrashLoopBackOff or an OOMKill. These ignore the alert window and can predate it.",
        }),
      ),
      startTime: opt(str({ description: "ISO8601 or unix-ms/sec. Clamped to the alert window." })),
      endTime: opt(str({ description: "ISO8601 or unix-ms/sec. Clamped to the alert window." })),
    }),
    execute: guarded(async (a, tw) => {
      init();
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
  });
}

function eventsTool(): SreTool {
  return sreTool({
    name: "k8s_get_events",
    cheap: false,
    retry: true,
    description:
      "Recent cluster events such as OOMKilled, evictions, scheduling and probe failures. Use them to tell an infrastructure fault from an application fault. " +
      "The tool ignores the alert window, and the cluster keeps about 1 h of events. Compare each lastTimestamp with the window before you cite the event. " +
      "type defaults to Warning. type=All returns every type.",
    parameters: obj({
      namespace: opt(str({ description: "Omit for all namespaces" })),
      type: opt(oneOf(["Warning", "Normal", "All"], { default: "Warning" })),
      involvedObjectName: opt(str({ description: "Pod / deployment / service name" })),
      limit: opt(int({ minimum: 1, maximum: 200, default: 50 })),
    }),
    execute: guarded(async (a) => {
      init();
      const sel: string[] = [];
      const type = a.type ?? "Warning";
      if (type !== "All") sel.push(`type=${type}`);
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
  });
}

function getDeploymentsTool(appNamespace: string): SreTool {
  return sreTool({
    name: "k8s_get_deployments",
    cheap: false,
    retry: true,
    description:
      "Replica counts, conditions, selector, and the live cpu and memory requests and limits of each container. " +
      "Compare an OOMKill or a heap ceiling with these limits. " +
      "Pass namespace and labelSelector, because an unscoped list is large.",
    parameters: obj({
      namespace: opt(str({ description: `Application workloads run in '${appNamespace}'` })),
      labelSelector: opt(str({ description: "e.g. app=foo" })),
      limit: opt(int({ minimum: 1, maximum: 200, default: 30 })),
    }),
    execute: guarded(async (a) => {
      init();
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
  });
}

function rolloutHistoryTool(): SreTool {
  return sreTool({
    name: "k8s_rollout_history",
    cheap: false,
    retry: true,
    description:
      "Revision history of one Deployment, newest first, with creation time, replicas and images. " +
      "Compare the creationTimestamp of a revision with the symptom onset before you blame a deploy.",
    parameters: obj({
      namespace: str(),
      name: str({ description: "Deployment name" }),
      limit: opt(int({ minimum: 1, maximum: 20, default: 10 })),
    }),
    execute: guarded(async (a) => {
      init();
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
  });
}

function nodesTool(): SreTool {
  return sreTool({
    name: "k8s_get_nodes",
    cheap: false,
    retry: true,
    description:
      "Production Kubernetes nodes, grouped by node pool, machine type, OS image, kernel, container runtime, kubelet and architecture. " +
      "It does not see VMs outside the cluster.",
    parameters: obj({}),
    execute: guarded(async () => {
      init();
      const res = await _core!.listNode();
      const groups = new Map<string, { nodes: string[]; notReady: number } & Record<string, unknown>>();
      for (const n of res.items) {
        const info = n.status?.nodeInfo;
        const labels = n.metadata?.labels ?? {};
        const facts = {
          pool: labels["cloud.google.com/gke-nodepool"],
          machineType: labels["node.kubernetes.io/instance-type"],
          osImage: info?.osImage,
          kernelVersion: info?.kernelVersion,
          containerRuntimeVersion: info?.containerRuntimeVersion,
          kubeletVersion: info?.kubeletVersion,
          architecture: info?.architecture,
        };
        const key = JSON.stringify(facts);
        const group = groups.get(key) ?? { ...facts, nodes: [], notReady: 0 };
        group.nodes.push(n.metadata?.name ?? "");
        if (n.status?.conditions?.find((c) => c.type === "Ready")?.status !== "True") group.notReady++;
        groups.set(key, group);
      }
      const items = [...groups.values()].map((g) => ({ ...g, count: g.nodes.length }));
      return textResult({ nodes: res.items.length, groups: items });
    }),
  });
}

function workloadOf(p: k8s.V1Pod): string {
  const owner = p.metadata?.ownerReferences?.[0];
  if (!owner) return `Pod/${p.metadata?.name}`;
  if (owner.kind === "ReplicaSet") return `Deployment/${owner.name.replace(/-[a-z0-9]+$/, "")}`;
  if (owner.kind === "Job") return `Job/${owner.name.replace(/-\d+$/, "")}`;
  return `${owner.kind}/${owner.name}`;
}

function imagesTool(appNamespace: string): SreTool {
  return sreTool({
    name: "k8s_list_images",
    cheap: false,
    retry: true,
    description:
      "Every image that runs in the production cluster now, init containers included, with its pod count and workloads. " +
      "Use it for the running version of a component, because a manifest tag such as latest can move. " +
      "With namespace or match, each line also gives the resolved digests.",
    parameters: obj({
      namespace: opt(
        str({ description: `Application workloads run in '${appNamespace}'. Omit it to read every namespace.` }),
      ),
      match: opt(
        str({ description: "Case-insensitive text that the image reference must contain, for example 'envoy'." }),
      ),
    }),
    execute: guarded(async (a) => {
      init();
      const res = a.namespace
        ? await _core!.listNamespacedPod({ namespace: a.namespace, fieldSelector: "status.phase=Running" })
        : await _core!.listPodForAllNamespaces({ fieldSelector: "status.phase=Running" });
      const needle = a.match?.toLowerCase();
      const images = new Map<string, { image: string; digests: Set<string>; workloads: Set<string>; pods: number }>();
      for (const p of res.items) {
        const statuses = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
        for (const c of statuses) {
          if (needle && !c.image.toLowerCase().includes(needle)) continue;
          const entry = images.get(c.image) ?? { image: c.image, digests: new Set(), workloads: new Set(), pods: 0 };
          const digest = c.imageID.split("@")[1];
          if (digest) entry.digests.add(digest);
          entry.workloads.add(`${p.metadata?.namespace}/${workloadOf(p)}`);
          entry.pods++;
          images.set(c.image, entry);
        }
      }
      const scoped = Boolean(a.namespace || a.match);
      const lines = [...images.values()]
        .sort((x, y) => x.image.localeCompare(y.image))
        .map((e) => {
          const digests = scoped && e.digests.size ? ` digests=${[...e.digests].join(",")}` : "";
          return `${e.image} pods=${e.pods} workloads=${[...e.workloads].join(",")}${digests}`;
        });
      const head = `${lines.length} images in ${res.items.length} running pods${scoped ? "" : ". Pass namespace or match to see digests."}`;
      return { content: [{ type: "text", text: [head, ...lines].join("\n") }] };
    }),
  });
}

export function kubernetesTools(appNamespace: string): SreTool[] {
  return [
    getPodsTool(appNamespace),
    podLogsTool(),
    eventsTool(),
    getDeploymentsTool(appNamespace),
    rolloutHistoryTool(),
    nodesTool(),
    imagesTool(appNamespace),
  ];
}
