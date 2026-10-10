import type { Context } from "@earendil-works/chord";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineTask,
  LiveDoc,
  type ConversationId,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { agentFor } from "../agent.ts";
import { removeReaction, replyMessage } from "../lark/client.ts";
import { followupTurn, steeringTurn } from "../prompt.ts";
import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { noteModelError, userFacingError } from "../utils/model-error.ts";
import { ctx, harness } from "./current.ts";
import { AlertDoc, json, ThreadDoc } from "./docs.ts";
import { failureText, stallMs, waitWithWatchdog, withConversationLock } from "./run.ts";
import { textOf } from "./transcript.ts";

export type ReplyInput = {
  threadKey: string;
  text: string;
  images: ImageContent[];
  maintainer: boolean;
  messageId: string;
  reactionId: string;
};
type ReplyState = { phase: "deliver" } | { phase: "send"; text: string | null };
type Runtime = TaskRuntime<ReplyInput, ReplyState, null, object>;

async function isBusy(runtime: Runtime, id: ConversationId, context: Context): Promise<boolean> {
  return (await runtime.snapshot(LiveDoc, id, context))?.run !== undefined;
}

async function sideConversation(main: ConversationId): Promise<ConversationId> {
  return harness().commit(async (tx) => {
    const latest = (await tx.scanEntries({ conversationId: main }, 1)).items[0];
    const created = latest
      ? await tx.forkConversation(main, latest.id, { ownership: { kind: "ownerless" } })
      : await tx.createConversation({ ownership: { kind: "ownerless" } });
    const alert = (await tx.doc(AlertDoc, main)).alert;
    (await tx.doc(AlertDoc, created.id)).alert = json(alert);
    (await tx.doc(ThreadDoc, main)).side = created.id;
    return created.id;
  }, ctx);
}

async function target(runtime: Runtime, context: Context): Promise<ConversationId> {
  const chosen = await runtime.memo<number>("target", context);
  if (chosen !== undefined) return chosen as ConversationId;
  const main = runtime.conversationId;
  const thread = await runtime.snapshot(ThreadDoc, main, context);
  let id = main;
  if (thread?.investigating) {
    const side = thread.side;
    id = side !== null && (await isBusy(runtime, side, context)) ? side : await sideConversation(main);
  }
  return (await runtime.memo<number>("target", id, context)) as ConversationId;
}

export const ReplyTask = defineTask<ReplyInput, ReplyState, null>({
  name: "sre.reply",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const { cfg } = state();
      const input = task.input;
      const labels = { thread: input.threadKey, message: input.messageId };
      const submitted = await withConversationLock(runtime.conversationId, async () => {
        const id = await target(runtime, context);
        const handle = await runtime.conversation(id, context);
        if (!handle) throw new Error(`conversation ${id} is gone`);
        let text: string;
        if (await isBusy(runtime, id, context)) {
          const granted = (await runtime.snapshot(ThreadDoc, id, context))?.maintainer ?? false;
          text = steeringTurn(input.text, granted && !input.maintainer);
          log.info("lark message steered into the running reply", labels);
        } else {
          await runtime.commit(async (tx) => {
            await configure(tx, id, agentFor(cfg, "followup", input.maintainer));
            const thread = await tx.doc(ThreadDoc, id);
            thread.maintainer = input.maintainer;
            thread.budget = null;
            return undefined;
          }, context);
          text = followupTurn(input.text);
        }
        const content = [{ type: "text" as const, text }, ...input.images];
        const submission = await handle.submit(
          { type: "input", content, whenBusy: "steer", requestId: `lark:${input.messageId}` },
          context,
        );
        return { id, handle, submission };
      });
      const ms = stallMs();
      const outcome = await waitWithWatchdog(submitted.handle, submitted.submission, ms, undefined, context);
      const failure = failureText(outcome, ms);
      const { settled } = outcome;
      if (failure && settled.status === "unanswered" && settled.reason !== "aborted") {
        // pi-durable leaves steers queued after a failed run, with no run to place them, so their tasks would wait forever.
        await submitted.handle.abort(context).catch(() => {});
      }
      await runtime.commit(async (tx) => {
        if (settled.status === "done" && settled.type === "input") {
          const answer = await tx.entry(AssistantEntry, settled.answer);
          const thread = await tx.doc(ThreadDoc, submitted.id);
          if (thread.posted.includes(settled.answer))
            return { status: "running", checkpoint: { phase: "send", text: null } };
          thread.posted.push(settled.answer);
          return {
            status: "running",
            checkpoint: { phase: "send", text: textOf(answer?.model?.[0]) || "(no response)" },
          };
        }
        if (!failure || (settled.status === "unanswered" && settled.reason === "aborted" && !outcome.stalled)) {
          return { status: "running", checkpoint: { phase: "send", text: null } };
        }
        if (!noteModelError(failure, labels)) log.warn("follow-up failed", { ...labels, error: failure });
        return { status: "running", checkpoint: { phase: "send", text: `⚠️ ${userFacingError(failure)}` } };
      }, context);
    },
    send: async (task, runtime, context) => {
      const { text } = task.state.checkpoint;
      const input = task.input;
      if (text && !(await runtime.memo<boolean>("sent", context))) {
        try {
          await replyMessage(input.threadKey, { markdown: text });
          await runtime.memo("sent", true, context);
        } catch (e) {
          log.warn("follow-up reply failed", { thread: input.threadKey, error: String(e) });
        }
      }
      await removeReaction(input.messageId, input.reactionId).catch(() => {});
      log.info("lark message replied", { thread: input.threadKey, posted: !!text });
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (task, runtime, context) => {
    await removeReaction(task.input.messageId, task.input.reactionId).catch(() => {});
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

export async function startReply(conversationId: ConversationId, input: ReplyInput): Promise<void> {
  const conversation = await harness().conversation(conversationId, ctx);
  if (!conversation) throw new Error(`no conversation ${conversationId}`);
  await conversation.commit(async (tx) => {
    await tx.createTask(ReplyTask, input, { ownership: { kind: "conversation" }, background: true });
  }, ctx);
}
