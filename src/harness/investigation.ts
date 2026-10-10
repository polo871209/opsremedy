import type { Context } from "@earendil-works/chord";
import { configure, defineTask, UsageDoc, type ConversationId, type TaskRuntime } from "@earendil-works/pi-durable";
import { agentFor, budgetFor, buildInvestigationPrompt, type InvestigationResult } from "../agent.ts";
import { DIAGNOSE_RETRY_TURN, DIAGNOSE_TURN } from "../prompt.ts";
import { diagnosisCard, progressCard, replyCard } from "../lark/card.ts";
import { replyMessage } from "../lark/client.ts";
import { state } from "../state.ts";
import { formatToolStatus } from "../tools/status.ts";
import { log } from "../utils/logger.ts";
import { noteModelError, userFacingError } from "../utils/model-error.ts";
import { makeProgressReporter, type ProgressReporter } from "../utils/progress.ts";
import { makeSemaphore, type Semaphore } from "../utils/semaphore.ts";
import { ctx, harness } from "./current.ts";
import { AlertDoc, alertOf, diagnosisOf, ThreadDoc } from "./docs.ts";
import { failureText, stallMs, waitWithWatchdog } from "./run.ts";
import { allEntries, assistantCount } from "./transcript.ts";

export type InvestigationInput = { threadKey: string; incidentId: string; progressMsgId: string };
type InvestigationState = { phase: "investigate" } | { phase: "diagnose" } | { phase: "report"; error: string | null };
type Runtime = TaskRuntime<InvestigationInput, InvestigationState, null, object>;

let slots: Semaphore | undefined;
export function investigationSlots(): Semaphore {
  slots ??= makeSemaphore(state().cfg.agent.maxConcurrent);
  return slots;
}

const reporters = new Map<string, ProgressReporter>();

function reporterFor(input: InvestigationInput): ProgressReporter | undefined {
  const id = input.progressMsgId;
  if (!id) return undefined;
  let reporter = reporters.get(id);
  if (!reporter) {
    reporter = makeProgressReporter(id, progressCard);
    reporters.set(id, reporter);
  }
  return reporter;
}

async function inSlot(runtime: Runtime, fn: () => Promise<string | undefined>): Promise<string | undefined> {
  await investigationSlots().acquire();
  try {
    return await fn();
  } catch (e) {
    if (runtime.signal.aborted) throw e;
    return e instanceof Error ? e.message : String(e);
  } finally {
    investigationSlots().release();
  }
}

async function run(
  runtime: Runtime,
  content: string,
  requestId: string,
  reporter: ProgressReporter | undefined,
  context: Context,
): Promise<string | undefined> {
  const handle = await runtime.conversation(runtime.conversationId, context);
  if (!handle) throw new Error(`conversation ${runtime.conversationId} is gone`);
  const ms = stallMs();
  const outcome = await waitWithWatchdog(
    handle,
    await handle.submit({ type: "input", content, requestId }, context),
    ms,
    (name, args) => reporter?.update(formatToolStatus(name, args)),
    context,
  );
  return failureText(outcome, ms);
}

function next(checkpoint: InvestigationState) {
  return { status: "running", checkpoint } as const;
}

export const InvestigationTask = defineTask<InvestigationInput, InvestigationState, null>({
  name: "sre.investigation",
  version: 1,
  initial: () => ({ phase: "investigate" }),
  phases: {
    investigate: async (task, runtime, context) => {
      const { cfg } = state();
      const conversationId = runtime.conversationId;
      const error = await inSlot(runtime, async () => {
        const reporter = reporterFor(task.input);
        reporter?.update("Starting investigation…");
        const alert = alertOf(await runtime.snapshot(AlertDoc, conversationId, context));
        if (!alert) throw new Error(`conversation ${conversationId} has no alert`);
        const prompt =
          (await runtime.memo<string>("prompt", context)) ??
          (await runtime.memo("prompt", await buildInvestigationPrompt(alert, cfg), context));
        await runtime.commit(async (tx) => {
          await configure(tx, conversationId, agentFor(cfg, "investigate"));
          const thread = await tx.doc(ThreadDoc, conversationId);
          thread.budget = budgetFor(cfg, alert);
          thread.maintainer = false;
          return undefined;
        }, context);
        return run(runtime, prompt, `investigate:${task.id}`, reporter, context);
      });
      await runtime.commit(() => next(error ? { phase: "report", error } : { phase: "diagnose" }), context);
    },
    diagnose: async (task, runtime, context) => {
      const { cfg } = state();
      const conversationId = runtime.conversationId;
      const error = await inSlot(runtime, async () => {
        const reporter = reporterFor(task.input);
        reporter?.update("Finalizing diagnosis…");
        await runtime.commit(async (tx) => {
          await configure(tx, conversationId, agentFor(cfg, "diagnose"));
          (await tx.doc(ThreadDoc, conversationId)).budget = null;
          return undefined;
        }, context);
        const failed = await run(runtime, DIAGNOSE_TURN, `diagnose:${task.id}`, reporter, context);
        if (failed) return failed;
        if ((await runtime.snapshot(ThreadDoc, conversationId, context))?.diagnosis) return undefined;
        log.info("forcing submit_diagnosis retry", { conversation: conversationId });
        return run(runtime, DIAGNOSE_RETRY_TURN, `diagnose-retry:${task.id}`, reporter, context);
      });
      await runtime.commit(() => next({ phase: "report", error: error ?? null }), context);
    },
    report: async (task, runtime, context) => {
      await report(task.input, runtime, task.state.checkpoint.error, context);
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

async function report(input: InvestigationInput, runtime: Runtime, error: string | null, context: Context) {
  const conversationId = runtime.conversationId;
  const [thread, usage, alertDoc, entries] = await Promise.all([
    runtime.snapshot(ThreadDoc, conversationId, context),
    runtime.snapshot(UsageDoc, conversationId, context),
    runtime.snapshot(AlertDoc, conversationId, context),
    harness().commit((tx) => allEntries(tx, conversationId), ctx),
  ]);
  const diagnosis = diagnosisOf(thread);
  const cost = Object.values(usage?.models ?? {}).reduce((sum, u) => sum + u.cost.total, 0);
  const result: InvestigationResult = diagnosis
    ? { diagnosis, turns: assistantCount(entries), stopped: "diagnosis", cost }
    : { turns: assistantCount(entries), stopped: "error", error: error ?? "No diagnosis submitted", cost };
  const alert = alertOf(alertDoc);
  const labels = { alert: alert?.name, root: input.threadKey };
  log.info("investigation done", { ...labels, stopped: result.stopped, turns: result.turns });
  if (result.error && !noteModelError(result.error, labels))
    log.warn("investigation failed", { ...labels, error: result.error });
  const card = diagnosis
    ? diagnosisCard(result)
    : replyCard(`⚠️ Investigation failed: ${userFacingError(result.error)}`);
  const reporter = reporterFor(input);
  if (!(await runtime.memo<boolean>("posted", context))) {
    try {
      if (reporter) await reporter.finalize(card);
      else await replyMessage(input.threadKey, { card });
      await runtime.memo("posted", true, context);
      log.info("diagnosis posted to thread", labels);
    } catch (e) {
      log.error("diagnosis post failed", e, labels);
    } finally {
      reporters.delete(input.progressMsgId);
    }
  }
  if (!alert?.endedAt) {
    const meta = await state()
      .incidentMeta.get(input.incidentId)
      .catch(() => null);
    if (meta?.endedAt) {
      await runtime.commit(async (tx) => {
        (await tx.doc(AlertDoc, conversationId)).alert.endedAt = meta.endedAt;
        return undefined;
      }, context);
    }
  }
}

export async function startInvestigation(conversationId: ConversationId, input: InvestigationInput): Promise<void> {
  const conversation = await harness().conversation(conversationId, ctx);
  if (!conversation) throw new Error(`no conversation ${conversationId}`);
  await conversation.commit(async (tx) => {
    const thread = await tx.doc(ThreadDoc, conversationId);
    if (thread.investigating) return;
    thread.investigating = true;
    await tx.createTask(InvestigationTask, input, { ownership: { kind: "conversation" }, background: true });
  }, ctx);
}
