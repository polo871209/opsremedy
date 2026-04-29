/**
 * Resolve a pod's top-level owner workload by walking ownerReferences.
 * Adapted from k8sgpt-ai/k8sgpt pkg/util/util.go GetParent.
 *
 * Two layers max in practice:
 *   Pod → ReplicaSet → Deployment
 *   Pod → Job        → CronJob
 *   Pod → StatefulSet
 *   Pod → DaemonSet
 *
 * For ReplicaSet/Job we read the controller (controller=true) ownerRef and,
 * if it points at a managed kind, fetch that resource's own ownerRefs. For
 * leaf workloads (Deployment/StatefulSet/DaemonSet/CronJob) we stop.
 *
 * Errors during the second hop fall back to the first owner — better to
 * report `ReplicaSet/foo-abc` than nothing.
 */

interface OwnerRef {
  kind?: string;
  name?: string;
  controller?: boolean;
}

interface MetaWithOwner {
  metadata?: { namespace?: string; ownerReferences?: OwnerRef[] };
}

/** Minimal shape we read from a ReplicaSet/Job during owner walk. */
type OwnerReadable = MetaWithOwner;
type OwnerReader = (req: { name: string; namespace: string }) => Promise<OwnerReadable>;

/** Pull the controlling ownerRef (or fall back to the first ref). */
export function controllerRef(meta: MetaWithOwner | undefined): OwnerRef | undefined {
  const refs = meta?.metadata?.ownerReferences ?? [];
  if (refs.length === 0) return undefined;
  return refs.find((r) => r.controller === true) ?? refs[0];
}

/** "Kind/name" for an ownerRef, or undefined if it can't be formatted. */
export function refLabel(ref: OwnerRef | undefined): string | undefined {
  if (!ref?.kind || !ref?.name) return undefined;
  return `${ref.kind}/${ref.name}`;
}

export interface OwnerWalkApis {
  apps: { readNamespacedReplicaSet: OwnerReader };
  batch: { readNamespacedJob: OwnerReader };
}

/**
 * Walk the ownerReferences to a top-level workload label. Performs at most
 * one extra API read (for ReplicaSet→Deployment or Job→CronJob).
 */
export async function resolvePodOwner(
  meta: MetaWithOwner | undefined,
  apis: OwnerWalkApis,
): Promise<string | undefined> {
  const first = controllerRef(meta);
  if (!first) return undefined;
  const namespace = meta?.metadata?.namespace;

  if (first.kind === "ReplicaSet" && first.name && namespace) {
    try {
      const rs = await apis.apps.readNamespacedReplicaSet({ name: first.name, namespace });
      const top = controllerRef(rs);
      return refLabel(top) ?? refLabel(first);
    } catch {
      return refLabel(first);
    }
  }

  if (first.kind === "Job" && first.name && namespace) {
    try {
      const job = await apis.batch.readNamespacedJob({ name: first.name, namespace });
      const top = controllerRef(job);
      return refLabel(top) ?? refLabel(first);
    } catch {
      return refLabel(first);
    }
  }

  return refLabel(first);
}
