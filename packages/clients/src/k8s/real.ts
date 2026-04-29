import { AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { EventSummary, PodSummary } from "@opsremedy/core/types";
import type {
  ClusterInfo,
  K8sClient,
  K8sDescribeQuery,
  K8sEventsQuery,
  K8sListPodsQuery,
  K8sLogsQuery,
} from "../types.ts";
import { resolvePodOwner } from "./parent.ts";

export interface RealK8sClientOptions {
  /** Path to kubeconfig. If unset, falls back to KUBECONFIG env or default loaders. */
  kubeconfigPath?: string;
  /** Override the active kubeconfig context. Falls through to current-context. */
  context?: string;
}

/**
 * Real Kubernetes client built on @kubernetes/client-node v1.x ObjectCoreV1Api.
 * Read-only: no mutating verbs are exposed.
 */
export class RealK8sClient implements K8sClient {
  private readonly core: CoreV1Api;
  private readonly apps: AppsV1Api;
  private readonly batch: BatchV1Api;

  constructor(opts: RealK8sClientOptions = {}) {
    const kc = new KubeConfig();
    if (opts.kubeconfigPath) {
      kc.loadFromFile(opts.kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    if (opts.context) {
      kc.setCurrentContext(opts.context);
    }
    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
    this.batch = kc.makeApiClient(BatchV1Api);
  }

  async listPods(q: K8sListPodsQuery): Promise<PodSummary[]> {
    const list = await this.core.listNamespacedPod({
      namespace: q.namespace,
      ...(q.labelSelector !== undefined && { labelSelector: q.labelSelector }),
      ...(q.fieldSelector !== undefined && { fieldSelector: q.fieldSelector }),
    });
    const items = list.items ?? [];
    const summaries = items.map(toPodSummary);
    // Resolve owners in parallel; failures fall back to first ownerRef.
    const apis = { apps: this.apps, batch: this.batch };
    const owners = await Promise.all(
      items.map((pod) => resolvePodOwner(pod as { metadata?: V1Pod["metadata"] }, apis)),
    );
    for (let i = 0; i < summaries.length; i++) {
      const o = owners[i];
      if (o) summaries[i] = { ...summaries[i], owner: o } as PodSummary;
    }
    return summaries;
  }

  async describe(q: K8sDescribeQuery): Promise<string> {
    const namespace = q.namespace ?? "default";
    if (q.kind === "pod") {
      const pod = await this.core.readNamespacedPod({
        name: q.name,
        namespace,
      });
      return renderPodDescribe(pod);
    }
    if (q.kind === "deployment") {
      const deployment = await this.apps.readNamespacedDeployment({ name: q.name, namespace });
      return renderWorkloadDescribe("Deployment", deployment);
    }
    if (q.kind === "statefulset") {
      const statefulSet = await this.apps.readNamespacedStatefulSet({ name: q.name, namespace });
      return renderWorkloadDescribe("StatefulSet", statefulSet);
    }
    if (q.kind === "job") {
      const job = await this.batch.readNamespacedJob({ name: q.name, namespace });
      return renderJobDescribe(job);
    }
    if (q.kind === "service") {
      const service = await this.core.readNamespacedService({ name: q.name, namespace });
      return renderServiceDescribe(service);
    }

    const node = await this.core.readNode({ name: q.name });
    return renderNodeDescribe(node);
  }

  async events(q: K8sEventsQuery): Promise<EventSummary[]> {
    const list = await this.core.listNamespacedEvent({
      namespace: q.namespace,
      ...(q.fieldSelector !== undefined && { fieldSelector: q.fieldSelector }),
    });
    return (list.items ?? []).map(toEventSummary);
  }

  async clusterInfo(_signal?: AbortSignal): Promise<ClusterInfo> {
    const [nodeList, nsList] = await Promise.all([this.core.listNode({}), this.core.listNamespace({})]);
    const nodes = nodeList.items ?? [];
    const ready = nodes.filter((n) => {
      const conds = (n as V1Node).status?.conditions ?? [];
      return conds.some((c) => c.type === "Ready" && c.status === "True");
    }).length;
    const namespaces = (nsList.items ?? [])
      .map((n) => (n as V1Workload).metadata?.name ?? "")
      .filter((s) => s.length > 0);
    return { nodes: { total: nodes.length, ready }, namespaces };
  }

  async podLogs(q: K8sLogsQuery): Promise<string[]> {
    const text = await this.core.readNamespacedPodLog({
      name: q.pod,
      namespace: q.namespace,
      ...(q.container !== undefined && { container: q.container }),
      tailLines: q.tailLines,
      ...(q.previous !== undefined && { previous: q.previous }),
    });
    if (!text) return [];
    return text.split("\n").filter((l) => l.length > 0);
  }
}

// ---------------- helpers ----------------

interface V1ContainerStateTerminated {
  reason?: string;
  exitCode?: number;
  finishedAt?: Date | string;
}
interface V1ContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  lastState?: { terminated?: V1ContainerStateTerminated };
  state?: { terminated?: V1ContainerStateTerminated; waiting?: { reason?: string } };
}
interface V1OwnerRef {
  kind?: string;
  name?: string;
  controller?: boolean;
}
interface V1Pod {
  metadata?: { name?: string; namespace?: string; ownerReferences?: V1OwnerRef[] };
  spec?: { nodeName?: string };
  status?: { phase?: string; containerStatuses?: V1ContainerStatus[] };
}

interface V1Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface V1ObjectMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
}

interface V1Workload {
  metadata?: V1ObjectMeta;
  spec?: { replicas?: number; selector?: { matchLabels?: Record<string, string> } };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    conditions?: V1Condition[];
  };
}

interface V1Job {
  metadata?: V1ObjectMeta;
  spec?: { parallelism?: number; completions?: number; backoffLimit?: number };
  status?: { active?: number; succeeded?: number; failed?: number; conditions?: V1Condition[] };
}

interface V1Service {
  metadata?: V1ObjectMeta;
  spec?: {
    type?: string;
    clusterIP?: string;
    selector?: Record<string, string>;
    ports?: Array<{ name?: string; port?: number; targetPort?: unknown; protocol?: string }>;
  };
}

interface V1Node {
  metadata?: V1ObjectMeta;
  spec?: { unschedulable?: boolean };
  status?: {
    conditions?: V1Condition[];
    nodeInfo?: { kubeletVersion?: string };
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
}

function toPodSummary(pod: V1Pod): PodSummary {
  const statuses = pod.status?.containerStatuses ?? [];
  const restarts = statuses.reduce((acc, s) => acc + (s.restartCount ?? 0), 0);
  const ready = statuses.length > 0 && statuses.every((s) => s.ready === true);
  const lastTerm = statuses.find((s) => s.lastState?.terminated?.reason)?.lastState?.terminated?.reason;
  return {
    namespace: pod.metadata?.namespace ?? "",
    name: pod.metadata?.name ?? "",
    phase: pod.status?.phase ?? "Unknown",
    ready,
    restarts,
    ...(lastTerm !== undefined && { lastTerminationReason: lastTerm }),
    ...(pod.spec?.nodeName !== undefined && { node: pod.spec.nodeName }),
  };
}

interface V1Event {
  metadata?: { namespace?: string };
  involvedObject?: { kind?: string; name?: string };
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: Date | string;
  eventTime?: Date | string;
}

function toEventSummary(ev: V1Event): EventSummary {
  const ts = ev.lastTimestamp ?? ev.eventTime ?? "";
  const lastSeen = typeof ts === "string" ? ts : ts.toISOString();
  const type: "Normal" | "Warning" = ev.type === "Warning" ? "Warning" : "Normal";
  return {
    namespace: ev.metadata?.namespace ?? "",
    involvedKind: ev.involvedObject?.kind ?? "",
    involvedName: ev.involvedObject?.name ?? "",
    type,
    reason: ev.reason ?? "",
    message: ev.message ?? "",
    count: ev.count ?? 1,
    lastSeen,
  };
}

function renderPodDescribe(pod: V1Pod): string {
  const lines: string[] = [];
  lines.push(`Name: ${pod.metadata?.name ?? "?"}`);
  lines.push(`Namespace: ${pod.metadata?.namespace ?? "?"}`);
  lines.push(`Node: ${pod.spec?.nodeName ?? "?"}`);
  lines.push(`Phase: ${pod.status?.phase ?? "?"}`);
  const statuses = pod.status?.containerStatuses ?? [];
  if (statuses.length > 0) {
    lines.push("Containers:");
    for (const s of statuses) {
      const waiting = s.state?.waiting?.reason;
      const term = s.state?.terminated?.reason ?? s.lastState?.terminated?.reason;
      const exit = s.state?.terminated?.exitCode ?? s.lastState?.terminated?.exitCode;
      lines.push(
        `  - ${s.name}: ready=${s.ready ?? false} restarts=${s.restartCount ?? 0}` +
          (waiting ? ` waiting=${waiting}` : "") +
          (term ? ` lastTermination=${term}${exit !== undefined ? ` (exit=${exit})` : ""}` : ""),
      );
    }
  }
  return lines.join("\n");
}

function renderWorkloadDescribe(kind: string, workload: V1Workload): string {
  const lines: string[] = [];
  lines.push(`Kind: ${kind}`);
  lines.push(`Name: ${workload.metadata?.name ?? "?"}`);
  lines.push(`Namespace: ${workload.metadata?.namespace ?? "?"}`);
  lines.push(
    `Replicas: desired=${workload.spec?.replicas ?? 0} ready=${workload.status?.readyReplicas ?? 0} updated=${workload.status?.updatedReplicas ?? 0} available=${workload.status?.availableReplicas ?? 0}`,
  );
  const selector = workload.spec?.selector?.matchLabels;
  if (selector && Object.keys(selector).length > 0) lines.push(`Selector: ${formatLabels(selector)}`);
  appendConditions(lines, workload.status?.conditions);
  return lines.join("\n");
}

function renderJobDescribe(job: V1Job): string {
  const lines: string[] = [];
  lines.push("Kind: Job");
  lines.push(`Name: ${job.metadata?.name ?? "?"}`);
  lines.push(`Namespace: ${job.metadata?.namespace ?? "?"}`);
  lines.push(`Parallelism: ${job.spec?.parallelism ?? 0}`);
  lines.push(`Completions: ${job.spec?.completions ?? 0}`);
  lines.push(`BackoffLimit: ${job.spec?.backoffLimit ?? 0}`);
  lines.push(
    `Status: active=${job.status?.active ?? 0} succeeded=${job.status?.succeeded ?? 0} failed=${job.status?.failed ?? 0}`,
  );
  appendConditions(lines, job.status?.conditions);
  return lines.join("\n");
}

function renderServiceDescribe(service: V1Service): string {
  const lines: string[] = [];
  lines.push("Kind: Service");
  lines.push(`Name: ${service.metadata?.name ?? "?"}`);
  lines.push(`Namespace: ${service.metadata?.namespace ?? "?"}`);
  lines.push(`Type: ${service.spec?.type ?? "?"}`);
  lines.push(`ClusterIP: ${service.spec?.clusterIP ?? "?"}`);
  if (service.spec?.selector && Object.keys(service.spec.selector).length > 0)
    lines.push(`Selector: ${formatLabels(service.spec.selector)}`);
  const ports = service.spec?.ports ?? [];
  if (ports.length > 0) {
    lines.push("Ports:");
    for (const p of ports)
      lines.push(
        `  - ${p.name ?? "unnamed"}: ${p.port ?? "?"} -> ${String(p.targetPort ?? "?")} ${p.protocol ?? "TCP"}`,
      );
  }
  return lines.join("\n");
}

function renderNodeDescribe(node: V1Node): string {
  const lines: string[] = [];
  lines.push("Kind: Node");
  lines.push(`Name: ${node.metadata?.name ?? "?"}`);
  lines.push(`Unschedulable: ${node.spec?.unschedulable ?? false}`);
  if (node.status?.nodeInfo?.kubeletVersion) lines.push(`Kubelet: ${node.status.nodeInfo.kubeletVersion}`);
  appendResourceMap(lines, "Capacity", node.status?.capacity);
  appendResourceMap(lines, "Allocatable", node.status?.allocatable);
  appendConditions(lines, node.status?.conditions);
  return lines.join("\n");
}

function appendConditions(lines: string[], conditions: V1Condition[] | undefined): void {
  if (!conditions?.length) return;
  lines.push("Conditions:");
  for (const c of conditions) {
    lines.push(
      `  - ${c.type ?? "?"}=${c.status ?? "?"}${c.reason ? ` reason=${c.reason}` : ""}${c.message ? ` message=${c.message}` : ""}`,
    );
  }
}

function appendResourceMap(lines: string[], label: string, values: Record<string, string> | undefined): void {
  if (!values || Object.keys(values).length === 0) return;
  lines.push(`${label}: ${formatLabels(values)}`);
}

function formatLabels(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}
