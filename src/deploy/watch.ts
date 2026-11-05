import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Alert } from "../alert.ts";
import { formatCardTime } from "../gcp/card.ts";
import { ctx, harness } from "../harness/current.ts";
import { AlertDoc, json, ThreadDoc, ThreadIndex } from "../harness/docs.ts";
import { InvestigationTask } from "../harness/investigation.ts";
import { keepUntilRestart } from "../harness/retention.ts";
import { collapsedPanel, progressCard } from "../lark/card.ts";
import { replyMessage } from "../lark/client.ts";
import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { checkTargets, type ServiceFinding } from "./checks.ts";
import type { DeployRun } from "./oidc.ts";
import { WINDOW_MS, windowOf, type DeployTarget } from "./target.ts";

// logging_googleapis_com:log_entry_count and kminion reach GMP about a minute late.
const INGEST_LAG_MS = 90 * 1000;
const MAX_SEED_CALLS = 10;

export type DeployWatchInput = {
  threadKey: string;
  run: DeployRun;
  targets: DeployTarget[];
  unwatched: string[];
};
type DeployWatchState = { phase: "wait" } | { phase: "check" } | { phase: "report"; findings: ServiceFinding[] };
type Runtime = TaskRuntime<DeployWatchInput, DeployWatchState, null, object>;

function runUrl(run: DeployRun): string {
  return `https://github.com/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt}`;
}

function cardTime(ms: number): string {
  return formatCardTime(ms / 1000, state().cfg.timezone);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function profile(t: DeployTarget): string {
  const kind = t.appType === "worker" ? "worker" : "API";
  return `${t.service} (${kind}${t.critical ? ", critical" : ""}, Deployment ${t.namespace}/${t.deployment})`;
}

function deployAlert(input: DeployWatchInput, targets: DeployTarget[]): Alert {
  return {
    name: `Production deploy ${input.run.sha.slice(0, 7)}`,
    source: "deploy-watch",
    severity: "info",
    startedAt: iso(Math.min(...targets.map((t) => t.appliedAtMs))),
    message: [`Run: ${runUrl(input.run)}`, "Services:", ...targets.map((t) => `- ${profile(t)}`)].join("\n"),
    labels: { sha: input.run.sha, actor: input.run.actor },
  };
}

function targetFacts(t: DeployTarget): string[] {
  const w = windowOf(t);
  const facts = [`rolled out ${cardTime(t.appliedAtMs)} to ${cardTime(t.finishedAtMs)}, watched until ${cardTime(w.endMs)}`];
  if (t.k8sService) facts.push(`Kubernetes Service ${t.k8sService}`);
  if (t.consumerGroups?.length) facts.push(`Kafka consumer groups: ${t.consumerGroups.join(", ")}`);
  return facts;
}

function regressionAlert(input: DeployWatchInput, flagged: ServiceFinding[]): Alert {
  const targets = flagged.map((f) => f.target);
  return {
    ...deployAlert(input, targets),
    name: "Post-deploy regression",
    severity: "error",
    service: flagged.length === 1 ? targets[0]!.service : undefined,
    message: [
      `Commit ${input.run.sha} was deployed to production by ${runUrl(input.run)}.`,
      `These services changed in the ${WINDOW_MS / 60_000} min after their rollout:`,
      ...flagged.flatMap((f) => [
        `- ${profile(f.target)}`,
        ...targetFacts(f.target).map((fact) => `  ${fact}`),
        ...f.reasons.map((r) => `  ${f.verdict}: ${r.text}`),
      ]),
    ].join("\n"),
  };
}

function seedCallsFor(flagged: ServiceFinding[]): NonNullable<Alert["seedCalls"]> {
  const calls = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const add = (tool: string, args: Record<string, unknown>) =>
    calls.set(`${tool}:${JSON.stringify(args)}`, { tool, args });
  for (const { target: t, reasons } of flagged) {
    const w = windowOf(t);
    const checks = new Set(reasons.map((r) => r.check));
    if (checks.has("rollout") || checks.has("pods")) {
      add("k8s_rollout_history", { namespace: t.namespace, name: t.deployment });
      add("k8s_get_pods", { namespace: t.namespace, labelSelector: `app=${t.deployment}` });
    }
    const pod = reasons.find((r) => r.pod)?.pod;
    if (pod)
      add("k8s_pod_logs", { namespace: t.namespace, name: pod, container: t.container, previous: true, tail: 100 });
    if (checks.has("logs") || checks.has("pods"))
      add("gcp_logging_query", {
        filter: `resource.type="k8s_container" AND resource.labels.namespace_name="${t.namespace}" AND resource.labels.container_name="${t.container}" AND severity>=ERROR`,
        startTime: iso(w.startMs),
        endTime: iso(w.endMs),
      });
    if (checks.has("traffic") && t.k8sService)
      add("promql_range", {
        query: `sum by (response_code) (rate(istio_requests_total{reporter=~"source|waypoint", destination_service_namespace="${t.namespace}", destination_service_name="${t.k8sService}"}[1m]))`,
        startTime: iso(w.baselineEndMs - 30 * 60_000),
        endTime: iso(w.endMs),
        step: "1m",
      });
    for (const group of new Set(reasons.map((r) => r.group).filter(Boolean)))
      add("kafka_describe_group", { groupId: group });
  }
  return [...calls.values()].slice(0, MAX_SEED_CALLS);
}

function serviceLine(f: ServiceFinding): string {
  const icon = f.verdict === "failed" ? "🔴" : "🟠";
  return `- ${icon} **${f.target.service}** ${f.verdict}: ${f.reasons.map((r) => r.text).join(", ")}`;
}

function resultCard(input: DeployWatchInput, findings: ServiceFinding[]): unknown {
  const flagged = findings.filter((f) => f.verdict !== "healthy");
  const healthy = findings.length - flagged.length;
  const lines = flagged.length
    ? [
        `⚠️ **Post-deploy check: ${flagged.length} of ${findings.length} services need attention.**`,
        ...flagged.map(serviceLine),
      ]
    : [`✅ **Post-deploy check passed.** ${findings.length} of ${findings.length} services are healthy.`];
  if (flagged.length && healthy)
    lines.push(healthy === 1 ? "The other service is healthy." : `The other ${healthy} services are healthy.`);
  if (input.unwatched.length)
    lines.push("", `Not watched, because CI sent no rollout facts: ${input.unwatched.join(", ")}`);
  lines.push(
    "",
    `Each service is watched for ${WINDOW_MS / 60_000} min after its own rollout. Every service gets rollout, pod and error-log checks. APIs also get Istio 5xx and p99, and workers get Kafka consumer members and lag.`,
  );
  const notChecked = findings.flatMap((f) => f.notChecked.map((n) => `${f.target.service}: ${n}`));
  const elements: unknown[] = [{ tag: "markdown", content: lines.join("\n") }];
  if (notChecked.length) elements.push(collapsedPanel("Not checked", notChecked));
  return { schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { elements } };
}

async function postOnce(runtime: Runtime, name: string, threadKey: string, card: unknown, context: Context) {
  const sent = await runtime.memo<string>(name, context);
  if (sent !== undefined) return sent;
  const id = await replyMessage(threadKey, { card });
  return runtime.memo(name, id, context);
}

const terminal = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export const DeployWatchTask = defineTask<DeployWatchInput, DeployWatchState, null>({
  name: "sre.deploy-watch",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const lastEnd = Math.max(...task.input.targets.map((t) => windowOf(t).endMs));
      await runtime.sleepUntil(lastEnd + INGEST_LAG_MS, { phase: "check" }, context);
    },
    check: async (task, runtime, context) => {
      const { input } = task;
      const findings = await checkTargets(input.targets, input.run.sha, state().cfg.prometheus.url);
      log.info("deploy watch checked", {
        root: input.threadKey,
        run: input.run.runId,
        flagged: findings.filter((f) => f.verdict !== "healthy").map((f) => f.target.service),
        notChecked: findings.reduce((n, f) => n + f.notChecked.length, 0),
      });
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", findings } }), context);
    },
    report: async (task, runtime, context) => {
      const { input } = task;
      const { findings } = task.state.checkpoint;
      const flagged = findings.filter((f) => f.verdict !== "healthy");
      const posted = await postOnce(runtime, "result", input.threadKey, resultCard(input, findings), context).catch(
        (e) => {
          log.error("deploy watch result post failed", e, { root: input.threadKey });
          return undefined;
        },
      );
      if (!posted || !flagged.length) {
        await runtime.commit(() => terminal, context);
        return;
      }
      const progressMsgId = await postOnce(
        runtime,
        "progress",
        input.threadKey,
        progressCard("Starting investigation…"),
        context,
      ).catch(() => "");
      await runtime.commit(async (tx) => {
        const conversationId = runtime.conversationId;
        const alert: Alert = { ...regressionAlert(input, flagged), seedCalls: seedCallsFor(flagged) };
        (await tx.doc(AlertDoc, conversationId)).alert = json(alert);
        const thread = await tx.doc(ThreadDoc, conversationId);
        if (!thread.investigating) {
          thread.investigating = true;
          await tx.createTask(
            InvestigationTask,
            { threadKey: input.threadKey, incidentId: `deploy:${input.run.runId}`, progressMsgId },
            { ownership: { kind: "conversation" }, background: true },
          );
        }
        return terminal;
      }, context);
      log.info("deploy watch investigation started", { root: input.threadKey, services: flagged.length });
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/** Opens the deploy thread's conversation and schedules its watch. Returns false when the thread already has one. */
export async function startDeployWatch(input: DeployWatchInput): Promise<boolean> {
  keepUntilRestart(input.threadKey);
  return harness().commit(async (tx) => {
    const index = await tx.doc(ThreadIndex, input.threadKey, null);
    if (index.conversationId !== null) return false;
    const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
    index.conversationId = id;
    (await tx.doc(AlertDoc, id)).alert = json(deployAlert(input, input.targets));
    const thread = await tx.doc(ThreadDoc, id);
    thread.threadKey = input.threadKey;
    thread.createdAt = Date.now();
    await tx.createTask(DeployWatchTask, input, {
      ownership: { kind: "conversation" },
      conversationId: id,
      background: true,
    });
    return true;
  }, ctx);
}
