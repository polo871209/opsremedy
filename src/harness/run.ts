import type { Context } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  LiveDoc,
  type ConversationHandle,
  type ConversationId,
  type ConversationView,
  type LiveState,
  type SettledSubmissionRecord,
  type Submission,
} from "@earendil-works/pi-durable";
import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { ctx, harness } from "./current.ts";

export function stallMs(): number {
  return state().cfg.agent.stallSeconds * 1000;
}

export interface RunOutcome {
  settled: SettledSubmissionRecord;
  stalled: boolean;
}

export async function waitWithWatchdog(
  handle: ConversationHandle,
  submission: Submission,
  stallMs: number,
  onTool: ((name: string, args: unknown) => void) | undefined,
  context: Context,
): Promise<RunOutcome> {
  const conversation = await harness().conversation(handle.id as ConversationId, ctx);
  if (!conversation) throw new Error(`conversation ${handle.id} is gone`);
  const watch = await conversation.watch(ctx);
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      log.warn("agent stalled; aborting run", { conversation: handle.id, stallMs });
      handle.abort(context).catch((e) => {
        log.warn("stall abort failed; retrying after the next stall window", { error: String(e) });
        rearm();
      });
    }, stallMs);
  };
  const callArgs = new Map<string, unknown>();
  const reported = new Set<string>();
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    rearm();
    if (!onTool) return;
    for (const c of toolCallsOf(call.value)) callArgs.set(c.id, c.arguments);
    const live = call.value.docs[LiveDoc.definition.kind] as LiveState | undefined;
    for (const slot of live?.tools ?? []) {
      if (slot.status === "pending" || reported.has(slot.callId)) continue;
      reported.add(slot.callId);
      onTool(slot.name, callArgs.get(slot.callId));
    }
  });
  rearm();
  try {
    return { settled: await submission.wait(context), stalled };
  } finally {
    clearTimeout(timer);
    await watch.stop();
  }
}

function toolCallsOf(view: ConversationView): ToolCall[] {
  return view.entries.flatMap((entry) =>
    AssistantEntry.is(entry) && entry.model?.[0]?.role === "assistant"
      ? entry.model[0].content.filter((c): c is ToolCall => c.type === "toolCall")
      : [],
  );
}

export function failureText(outcome: RunOutcome, stallMs: number): string | undefined {
  const { settled } = outcome;
  if (settled.status === "done") return undefined;
  if (outcome.stalled) return `agent stalled: no progress for ${Math.round(stallMs / 1000)}s`;
  if (typeof settled.detail === "string") return settled.detail;
  if (settled.detail != null) return JSON.stringify(settled.detail);
  return `run ended unanswered (${settled.reason})`;
}

const locks = new Map<ConversationId, Promise<unknown>>();

export async function withConversationLock<T>(key: ConversationId, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  const settled = result.catch(() => {});
  locks.set(key, settled);
  try {
    return await result;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}
