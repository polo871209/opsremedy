import type * as k8s from "@kubernetes/client-node";
import { k8sClients } from "../tools/kubernetes.ts";
import { promFetch } from "../tools/prom.ts";
import { makeSemaphore } from "../utils/semaphore.ts";
import { WINDOW_MS, windowOf, type DeployTarget } from "./target.ts";

const BASELINE_SECONDS = 30 * 60;
const BAD_WAITING = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

export type Verdict = "healthy" | "degraded" | "failed";
export type Check = "rollout" | "pods" | "logs" | "traffic" | "kafka";
export type Reason = { check: Check; text: string; pod?: string; group?: string };
export type ServiceFinding = { target: DeployTarget; verdict: Verdict; reasons: Reason[]; notChecked: string[] };

const RANK: Record<Verdict, number> = { healthy: 0, degraded: 1, failed: 2 };

class Finding {
  verdict: Verdict = "healthy";
  readonly reasons: Reason[] = [];
  readonly notChecked: string[] = [];
  constructor(readonly target: DeployTarget) {}
  flag(verdict: Exclude<Verdict, "healthy">, reason: Reason): void {
    if (RANK[verdict] > RANK[this.verdict]) this.verdict = verdict;
    this.reasons.push(reason);
  }
  toJSON(): ServiceFinding {
    return { target: this.target, verdict: this.verdict, reasons: this.reasons, notChecked: this.notChecked };
  }
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: number }).code === 404;
}

function appContainer<T extends { name: string }>(containers: T[] | undefined, name: string): T | undefined {
  return containers?.find((c) => c.name === name);
}

async function checkRollout(f: Finding, sha: string): Promise<boolean> {
  const t = f.target;
  const { apps, core } = k8sClients();
  if (t.rolloutResult === "failure")
    f.flag("failed", { check: "rollout", text: "kubectl rollout status failed in CI" });
  let dep: k8s.V1Deployment;
  try {
    dep = await apps.readNamespacedDeployment({ namespace: t.namespace, name: t.deployment });
  } catch (e) {
    if (!isNotFound(e)) throw e;
    f.flag("failed", { check: "rollout", text: `Deployment ${t.namespace}/${t.deployment} does not exist` });
    return false;
  }
  const image = appContainer(dep.spec?.template.spec?.containers, t.container)?.image ?? "";
  if (!image.endsWith(`:${sha}`)) {
    const tag = image.split(":").pop()?.slice(0, 7);
    f.flag("failed", { check: "rollout", text: `runs image tag ${tag}, not this deploy's ${sha.slice(0, 7)}` });
  }
  const desired = dep.spec?.replicas ?? 1;
  const available = dep.status?.availableReplicas ?? 0;
  const updated = dep.status?.updatedReplicas ?? 0;
  if (desired > 0 && available === 0)
    f.flag("failed", { check: "rollout", text: `0 of ${desired} replicas are available` });
  else if (available < desired || updated < desired)
    f.flag("degraded", {
      check: "rollout",
      text: `${available} of ${desired} replicas are available, ${updated} run the new version`,
    });

  const pods = await core.listNamespacedPod({ namespace: t.namespace, labelSelector: `app=${t.deployment}` });
  const fresh = pods.items.filter((p) => appContainer(p.spec?.containers, t.container)?.image?.endsWith(`:${sha}`));
  const waiting = new Map<string, string[]>();
  const oomKilled: string[] = [];
  let restarts = 0;
  let restartedPod: string | undefined;
  for (const pod of fresh) {
    const status = appContainer(pod.status?.containerStatuses, t.container);
    if (!status) continue;
    const name = pod.metadata?.name ?? "";
    const reason = status.state?.waiting?.reason;
    if (reason && BAD_WAITING.has(reason)) waiting.set(reason, [...(waiting.get(reason) ?? []), name]);
    if (status.lastState?.terminated?.reason === "OOMKilled") oomKilled.push(name);
    if (status.restartCount) {
      restarts += status.restartCount;
      restartedPod ??= name;
    }
  }
  for (const [reason, names] of waiting)
    f.flag("failed", { check: "pods", text: `${names.length} new pods are in ${reason}`, pod: names[0] });
  if (oomKilled.length)
    f.flag("failed", { check: "pods", text: `${oomKilled.length} new pods were OOMKilled`, pod: oomKilled[0] });
  else if (restarts)
    f.flag("degraded", { check: "pods", text: `new pods restarted ${restarts} times`, pod: restartedPod });
  return true;
}

type Vector = Map<string, number>;

async function instant(promUrl: string, query: string, atMs: number, label: string): Promise<Vector> {
  const params = new URLSearchParams({ query, time: String(atMs / 1000) });
  const { ok, body } = await promFetch(promUrl, "/api/v1/query", params);
  if (!ok) throw new Error(`Prometheus query failed: ${JSON.stringify(body).slice(0, 200)}`);
  const rows = (body as { data: { result: { metric: Record<string, string>; value: [number, string] }[] } }).data
    .result;
  return new Map(rows.map((r) => [r.metric[label] ?? "", Number(r.value[1])]));
}

function worstBefore(expr: string, stepSeconds: number): string {
  return `max_over_time((${expr})[${BASELINE_SECONDS}s:${stepSeconds}s])`;
}

function regressed(after: number, worst: number, floor: number): boolean {
  return after > floor && after > 2 * worst;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

const WINDOW_SECONDS = WINDOW_MS / 1000;
const WINDOW_MINUTES = WINDOW_SECONDS / 60;

async function checkErrorLogs(promUrl: string, f: Finding): Promise<void> {
  const t = f.target;
  const w = windowOf(t);

  const errors = `sum by (container_name) (increase(logging_googleapis_com:log_entry_count{monitored_resource="k8s_container", namespace_name="${t.namespace}", container_name="${t.container}", severity=~"ERROR|CRITICAL|ALERT|EMERGENCY"}[${WINDOW_SECONDS}s]))`;
  const [after, before] = await Promise.all([
    instant(promUrl, errors, w.endMs, "container_name"),
    instant(promUrl, worstBefore(errors, WINDOW_SECONDS), w.baselineEndMs, "container_name"),
  ]);
  const count = Math.round(after.get(t.container) ?? 0);
  const worst = Math.round(before.get(t.container) ?? 0);
  if (regressed(count, worst, 10))
    f.flag("degraded", {
      check: "logs",
      text: `${count} error logs in ${WINDOW_MINUTES} min, the worst ${WINDOW_MINUTES} min before the deploy had ${worst}`,
    });
}

const SERVICE_LABEL = "destination_service_name";

async function checkTraffic(promUrl: string, f: Finding): Promise<void> {
  const t = f.target;
  if (!t.k8sService) {
    f.notChecked.push("Istio traffic: the manifest has no Service");
    return;
  }
  const w = windowOf(t);

  const selector = `reporter=~"source|waypoint", destination_service_namespace="${t.namespace}", destination_service_name="${t.k8sService}"`;
  const requests = (extra = "") =>
    `sum by (destination_service_name) (increase(istio_requests_total{${selector}${extra}}[${WINDOW_SECONDS}s]))`;
  const ratio = `${requests(', response_code=~"5.."')} / ${requests()}`;
  const p99 = `histogram_quantile(0.99, sum by (destination_service_name, le) (rate(istio_request_duration_milliseconds_bucket{${selector}}[${WINDOW_SECONDS}s])))`;
  const [total, errorRatio, latency, worstRatio, worstLatency] = await Promise.all([
    instant(promUrl, requests(), w.endMs, SERVICE_LABEL),
    instant(promUrl, ratio, w.endMs, SERVICE_LABEL),
    instant(promUrl, p99, w.endMs, SERVICE_LABEL),
    instant(promUrl, worstBefore(ratio, WINDOW_SECONDS), w.baselineEndMs, SERVICE_LABEL),
    instant(promUrl, worstBefore(p99, WINDOW_SECONDS), w.baselineEndMs, SERVICE_LABEL),
  ]);
  const n = total.get(t.k8sService) ?? 0;
  if (n < 30) {
    f.notChecked.push(`Istio traffic: ${Math.round(n)} requests in ${WINDOW_MINUTES} min are too few to judge`);
    return;
  }
  const r = errorRatio.get(t.k8sService) ?? 0;
  const worstR = worstRatio.get(t.k8sService) ?? 0;
  if (regressed(r, worstR, 0.05))
    f.flag("degraded", {
      check: "traffic",
      text: `5xx is ${pct(r)} of ${Math.round(n)} requests, the worst ${WINDOW_MINUTES} min before the deploy was ${pct(worstR)}`,
    });
  const ms = latency.get(t.k8sService) ?? 0;
  const worstMs = worstLatency.get(t.k8sService) ?? 0;
  if (regressed(ms, worstMs, 500))
    f.flag("degraded", {
      check: "traffic",
      text: `p99 latency is ${Math.round(ms)} ms, the worst ${WINDOW_MINUTES} min before the deploy was ${Math.round(worstMs)} ms`,
    });
}

const MEMBERS_SETTLE_SECONDS = 120;

async function checkConsumerGroups(promUrl: string, f: Finding): Promise<void> {
  const t = f.target;
  for (const expr of t.unresolvedGroups) f.notChecked.push(`consumer group computed at runtime: ${expr}`);
  if (t.consumerGroups === null) {
    f.notChecked.push("consumer groups: CI sent no bundle facts");
    return;
  }
  if (!t.consumerGroups.length) return;
  const w = windowOf(t);

  const groups = `group_id=~"${t.consumerGroups.join("|")}"`;
  const members = `max by (group_id) (kminion_kafka_consumer_group_members{${groups}})`;
  const lag = `sum by (group_id) (kminion_kafka_consumer_group_topic_lag{${groups}})`;
  const [membersBefore, membersAfter, lagBefore, lagAfter] = await Promise.all([
    instant(promUrl, `max_over_time((${members})[${BASELINE_SECONDS}s:60s])`, w.baselineEndMs, "group_id"),
    instant(promUrl, `max_over_time((${members})[${MEMBERS_SETTLE_SECONDS}s:30s])`, w.endMs, "group_id"),
    instant(promUrl, worstBefore(lag, 60), w.baselineEndMs, "group_id"),
    instant(promUrl, `max_over_time((${lag})[${WINDOW_SECONDS}s:60s])`, w.endMs, "group_id"),
  ]);
  const idle: string[] = [];
  for (const group of t.consumerGroups) {
    if (!membersBefore.get(group)) {
      idle.push(group);
      continue;
    }
    if (!membersAfter.get(group))
      f.flag("failed", {
        check: "kafka",
        group,
        text: `consumer group ${group} has had no members for ${MEMBERS_SETTLE_SECONDS / 60} min`,
      });
    const after = Math.round(lagAfter.get(group) ?? 0);
    const worst = Math.round(lagBefore.get(group) ?? 0);
    if (regressed(after, worst, 100))
      f.flag("degraded", {
        check: "kafka",
        group,
        text: `consumer group ${group} lag reached ${after}, the worst in the 30 min before the deploy was ${worst}`,
      });
  }
  if (idle.length) f.notChecked.push(`consumer groups with no members before the deploy: ${idle.join(", ")}`);
}

async function checkOne(f: Finding, sha: string, promUrl: string): Promise<void> {
  const t = f.target;
  let exists: boolean;
  try {
    exists = await checkRollout(f, sha);
  } catch (e) {
    f.notChecked.push(`rollout and pods: ${String(e).slice(0, 200)}`);
    exists = true;
  }
  if (!exists) return;
  const checks: [string, () => Promise<void>][] = [["error logs", () => checkErrorLogs(promUrl, f)]];
  if (t.appType === "api") checks.push(["Istio traffic", () => checkTraffic(promUrl, f)]);
  if (t.appType === "worker" || t.consumerGroups?.length || t.unresolvedGroups.length)
    checks.push(["consumer groups", () => checkConsumerGroups(promUrl, f)]);
  const results = await Promise.allSettled(checks.map(([, run]) => run()));
  results.forEach((r, i) => {
    if (r.status === "rejected") f.notChecked.push(`${checks[i]![0]}: ${String(r.reason).slice(0, 200)}`);
  });
}

export async function checkTargets(targets: DeployTarget[], sha: string, promUrl: string): Promise<ServiceFinding[]> {
  const slots = makeSemaphore(6);
  const findings = targets.map((t) => new Finding(t));
  await Promise.all(
    findings.map(async (f) => {
      await slots.acquire();
      try {
        await checkOne(f, sha, promUrl);
      } finally {
        slots.release();
      }
    }),
  );
  return findings.map((f) => f.toJSON());
}
