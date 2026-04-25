import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { EventSummary, PodSummary } from "@opsremedy/core/types";
import type {
  K8sClient,
  K8sDescribeQuery,
  K8sEventsQuery,
  K8sListPodsQuery,
  K8sLogsQuery,
} from "../types.ts";

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
  }

  async listPods(q: K8sListPodsQuery): Promise<PodSummary[]> {
    const list = await this.core.listNamespacedPod({
      namespace: q.namespace,
      ...(q.labelSelector !== undefined && { labelSelector: q.labelSelector }),
      ...(q.fieldSelector !== undefined && { fieldSelector: q.fieldSelector }),
    });
    return (list.items ?? []).map(toPodSummary);
  }

  async describe(q: K8sDescribeQuery): Promise<string> {
    // Only `pod` is fully supported for now; other kinds return a stub the LLM can read.
    if (q.kind === "pod") {
      const pod = await this.core.readNamespacedPod({
        name: q.name,
        namespace: q.namespace ?? "default",
      });
      return renderPodDescribe(pod);
    }
    return `describe for kind=${q.kind} not implemented; use kubectl describe ${q.kind}/${q.name} manually.`;
  }

  async events(q: K8sEventsQuery): Promise<EventSummary[]> {
    const list = await this.core.listNamespacedEvent({
      namespace: q.namespace,
      ...(q.fieldSelector !== undefined && { fieldSelector: q.fieldSelector }),
    });
    return (list.items ?? []).map(toEventSummary);
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
interface V1Pod {
  metadata?: { name?: string; namespace?: string };
  spec?: { nodeName?: string };
  status?: { phase?: string; containerStatuses?: V1ContainerStatus[] };
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
