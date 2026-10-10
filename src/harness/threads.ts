import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Alert } from "../alert.ts";
import { ctx, harness } from "./current.ts";
import { AlertDoc, alertOf, handoffOf, json, ThreadDoc, ThreadIndex, type HandoffDoc } from "./docs.ts";
import { keepUntilRestart } from "./retention.ts";
import { allEntries, messagesOf } from "./transcript.ts";

export interface AlertMeta {
  alertName: string;
  alertStartedAt?: string;
  alertEndedAt?: string;
  complete?: boolean;
}

export interface ThreadMeta extends AlertMeta {
  createdAt: number;
}

export async function threadConversation(threadKey: string): Promise<ConversationId | undefined> {
  keepUntilRestart(threadKey);
  return (await harness().snapshot(ThreadIndex, threadKey, ctx))?.conversationId ?? undefined;
}

async function required(threadKey: string): Promise<ConversationId> {
  const id = await threadConversation(threadKey);
  if (id === undefined) throw new Error(`no conversation for thread ${threadKey}`);
  return id;
}

export async function createThread(threadKey: string, alert: Alert): Promise<ConversationId> {
  keepUntilRestart(threadKey);
  return harness().commit(async (tx) => {
    const index = await tx.doc(ThreadIndex, threadKey, null);
    if (index.conversationId !== null) return index.conversationId;
    const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
    index.conversationId = id;
    (await tx.doc(AlertDoc, id)).alert = json(alert);
    const thread = await tx.doc(ThreadDoc, id);
    thread.threadKey = threadKey;
    thread.createdAt = Date.now();
    return id;
  }, ctx);
}

export async function threadMeta(threadKey: string): Promise<ThreadMeta | undefined> {
  const id = await threadConversation(threadKey);
  if (id === undefined) return undefined;
  const [alertDoc, thread] = await Promise.all([
    harness().snapshot(AlertDoc, id, ctx),
    harness().snapshot(ThreadDoc, id, ctx),
  ]);
  const alert = alertOf(alertDoc);
  return {
    alertName: alert?.name ?? "",
    alertStartedAt: alert?.startedAt,
    alertEndedAt: alert?.endedAt,
    complete: !thread?.investigating,
    createdAt: thread?.createdAt ?? 0,
  };
}

export async function patchThreadAlert(threadKey: string, patch: Partial<Pick<Alert, "startedAt" | "endedAt">>) {
  const id = await threadConversation(threadKey);
  if (id === undefined) return;
  await harness().commit(async (tx) => {
    const { alert } = await tx.doc(AlertDoc, id);
    for (const key of ["startedAt", "endedAt"] as const) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value) alert[key] = value;
      else delete alert[key];
    }
  }, ctx);
}

export async function threadTranscript(threadKey: string): Promise<Message[]> {
  const id = await threadConversation(threadKey);
  if (id === undefined) return [];
  return messagesOf(await harness().commit((tx) => allEntries(tx, id), ctx));
}

export async function getHandoff(threadKey: string): Promise<HandoffDoc | undefined> {
  const id = await threadConversation(threadKey);
  if (id === undefined) return undefined;
  return handoffOf(await harness().snapshot(ThreadDoc, id, ctx));
}

export async function saveHandoff(threadKey: string, doc: HandoffDoc): Promise<void> {
  const id = await required(threadKey);
  await harness().commit(async (tx) => {
    (await tx.doc(ThreadDoc, id)).handoff = json(doc);
  }, ctx);
}

export async function recordNote(threadKey: string, text: string): Promise<void> {
  const id = await required(threadKey);
  const conversation = await harness().conversation(id, ctx);
  if (!conversation) throw new Error(`conversation ${id} is gone`);
  await conversation.submit(
    { type: "write", entry: { kind: "sre.note", model: [{ role: "user", content: text, timestamp: Date.now() }] } },
    ctx,
  );
}
