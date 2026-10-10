import type { Message, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  UserEntry,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";

const PAGE = 200;

export async function allEntries(tx: Tx, conversationId: ConversationId): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "ascending" }, PAGE, cursor);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return out;
}

export async function entriesSinceUser(tx: Tx, conversationId: ConversationId): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId }, PAGE, cursor);
    for (const entry of page.items) {
      if (UserEntry.is(entry)) return out.reverse();
      out.push(entry);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return out.reverse();
}

export function messagesOf(entries: readonly EntryRecord[]): Message[] {
  return entries.flatMap((e) => e.model ?? []).filter((m) => m.role !== "system");
}

export function roundsOf(entries: readonly EntryRecord[]): ToolCall[][] {
  return entries.filter((e) => AssistantEntry.is(e)).map((e) => toolCallsOf(e.model?.[0]));
}

export function assistantCount(entries: readonly EntryRecord[]): number {
  return entries.filter((e) => AssistantEntry.is(e)).length;
}

function toolCallsOf(message: Message | undefined): ToolCall[] {
  if (message?.role !== "assistant") return [];
  return message.content.filter((c): c is ToolCall => c.type === "toolCall");
}

export function textOf(message: Message | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim();
}
