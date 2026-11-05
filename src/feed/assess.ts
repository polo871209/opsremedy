import type { Context } from "@earendil-works/chord";
import { configure, defineTask, UsageDoc, type TaskRuntime } from "@earendil-works/pi-durable";
import { agentFor, budgetFor } from "../agent.ts";
import type { Alert } from "../alert.ts";
import type { Assessment } from "../assessment.ts";
import { ctx, harness } from "../harness/current.ts";
import { AlertDoc, alertOf, AssessmentDoc, json, ThreadDoc, ThreadIndex } from "../harness/docs.ts";
import { inSlot, run } from "../harness/investigation.ts";
import { keepUntilRestart } from "../harness/retention.ts";
import { collapsedPanel, replyCard } from "../lark/card.ts";
import { replyMessage } from "../lark/client.ts";
import { formatAlertContext, VERDICT_RETRY_TURN, VERDICT_TURN } from "../prompt.ts";
import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { noteModelError, userFacingError } from "../utils/model-error.ts";
import { decodeEntities, type FeedItem } from "./rss.ts";

export type ThreatAssessmentInput = { threadKey: string };
type ThreatAssessmentState = { phase: "assess" } | { phase: "verdict" } | { phase: "report"; error: string | null };
type Runtime = TaskRuntime<ThreatAssessmentInput, ThreatAssessmentState, null, object>;

// The briefing's <pre> block is a prompt written for other agents, so it is dropped, not passed on.
function htmlToText(html: string): string {
  const text = html
    .replace(/<pre[\s\S]*?<\/pre>/g, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "$2 ($1)")
    .replace(/<h2[^>]*>/g, "\n## ")
    .replace(/<h3[^>]*>/g, "\n### ")
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/(p|h2|h3|ul|ol)>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function briefingAlert(feedTitle: string, item: FeedItem): Alert {
  const body = item.content ? htmlToText(item.content) : item.summary;
  const published = Number.isNaN(item.publishedAt) ? Date.now() : item.publishedAt;
  return {
    name: item.title,
    source: "threat-feed",
    severity: "info",
    startedAt: new Date(published).toISOString(),
    message: `Briefing from ${feedTitle}: ${item.link}\n\n${body}`,
    labels: { feed: feedTitle, guid: item.guid },
  };
}

function verdictCard(a: Assessment, cost: number): unknown {
  const elements: unknown[] = [
    { tag: "markdown", content: `🔴 **Action required: production is exposed**\n${a.summary}` },
  ];
  if (a.affected.length)
    elements.push({ tag: "markdown", content: `**Affected**\n${a.affected.map((l) => `- ${l}`).join("\n")}` });
  if (a.actions.length)
    elements.push({
      tag: "markdown",
      content: `**What to do**\n${a.actions.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    });
  if (a.evidence.length) elements.push(collapsedPanel("Evidence", a.evidence));
  elements.push({ tag: "markdown", content: `<font color='grey'>~$${cost.toFixed(3)}</font>` });
  return { schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { elements } };
}

function next(checkpoint: ThreatAssessmentState) {
  return { status: "running", checkpoint } as const;
}

async function report(runtime: Runtime, threadKey: string, error: string | null, context: Context): Promise<void> {
  const id = runtime.conversationId;
  const [doc, usage] = await Promise.all([
    runtime.snapshot(AssessmentDoc, id, context),
    runtime.snapshot(UsageDoc, id, context),
  ]);
  const assessment = (doc?.assessment ?? undefined) as Assessment | undefined;
  const cost = Object.values(usage?.models ?? {}).reduce((sum, u) => sum + u.cost.total, 0);
  const labels = { root: threadKey, conversation: id };
  log.info("threat assessment done", { ...labels, actionRequired: assessment?.actionRequired, cost });
  if (assessment && !assessment.actionRequired) return;
  const failure = error ?? "No verdict submitted";
  if (!assessment && !noteModelError(failure, labels))
    log.warn("threat assessment failed", { ...labels, error: failure });
  if (await runtime.memo<boolean>("posted", context)) return;
  const card = assessment
    ? verdictCard(assessment, cost)
    : replyCard(`⚠️ Exposure check failed: ${userFacingError(failure)}`);
  try {
    await replyMessage(threadKey, { card });
    await runtime.memo("posted", true, context);
  } catch (e) {
    log.error("threat assessment post failed", e, labels);
  }
}

export const ThreatAssessmentTask = defineTask<ThreatAssessmentInput, ThreatAssessmentState, null>({
  name: "sre.threat-assessment",
  version: 1,
  initial: () => ({ phase: "assess" }),
  phases: {
    assess: async (task, runtime, context) => {
      const { cfg } = state();
      const id = runtime.conversationId;
      const error = await inSlot(runtime, async () => {
        const alert = alertOf(await runtime.snapshot(AlertDoc, id, context));
        if (!alert) throw new Error(`conversation ${id} has no briefing`);
        await runtime.commit(async (tx) => {
          await configure(tx, id, agentFor(cfg, "assess"));
          const thread = await tx.doc(ThreadDoc, id);
          thread.budget = budgetFor(cfg, alert);
          thread.maintainer = false;
          return undefined;
        }, context);
        return run(runtime, formatAlertContext(alert), `assess:${task.id}`, undefined, context);
      });
      await runtime.commit(() => next(error ? { phase: "report", error } : { phase: "verdict" }), context);
    },
    verdict: async (task, runtime, context) => {
      const { cfg } = state();
      const id = runtime.conversationId;
      const error = await inSlot(runtime, async () => {
        await runtime.commit(async (tx) => {
          await configure(tx, id, agentFor(cfg, "verdict"));
          (await tx.doc(ThreadDoc, id)).budget = null;
          return undefined;
        }, context);
        const failed = await run(runtime, VERDICT_TURN, `verdict:${task.id}`, undefined, context);
        if (failed) return failed;
        if ((await runtime.snapshot(AssessmentDoc, id, context))?.assessment) return undefined;
        return run(runtime, VERDICT_RETRY_TURN, `verdict-retry:${task.id}`, undefined, context);
      });
      await runtime.commit(() => next({ phase: "report", error: error ?? null }), context);
    },
    report: async (task, runtime, context) => {
      await report(runtime, task.input.threadKey, task.state.checkpoint.error, context);
      await runtime.commit(async (tx) => {
        (await tx.doc(ThreadDoc, runtime.conversationId)).investigating = false;
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(async (tx) => {
      (await tx.doc(ThreadDoc, runtime.conversationId)).investigating = false;
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

/** Opens the feed card's thread conversation and starts its threat assessment. Returns false when the thread already has a conversation. */
export async function startThreatAssessment(threadKey: string, feedTitle: string, item: FeedItem): Promise<boolean> {
  keepUntilRestart(threadKey);
  return harness().commit(async (tx) => {
    const index = await tx.doc(ThreadIndex, threadKey, null);
    if (index.conversationId !== null) return false;
    const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
    index.conversationId = id;
    (await tx.doc(AlertDoc, id)).alert = json(briefingAlert(feedTitle, item));
    const thread = await tx.doc(ThreadDoc, id);
    thread.threadKey = threadKey;
    thread.createdAt = Date.now();
    thread.investigating = true;
    await tx.createTask(
      ThreatAssessmentTask,
      { threadKey },
      {
        ownership: { kind: "conversation" },
        conversationId: id,
        background: true,
      },
    );
    return true;
  }, ctx);
}
