import type { ImageContent, Message } from "@earendil-works/pi-ai";
import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { startReply } from "../harness/reply.ts";
import {
  createThread,
  patchThreadAlert,
  recordNote,
  threadConversation,
  threadMeta,
  threadTranscript,
  type AlertMeta,
} from "../harness/threads.ts";
import { triage } from "../triage.ts";
import { handoffUrl } from "../session/link.ts";
import { ensureHandoff } from "../session/handoff-synthesis.ts";
import {
  replyMessage,
  listThreadMessages,
  addReaction,
  removeReaction,
  downloadImage,
  type ThreadItem,
} from "./client.ts";
import { untrusted } from "../prompt.ts";
import { parseMessageBody, type IncomingMessage } from "./event.ts";

const HANDOFF_WORD = String.raw`\/?hand[\s-]?off`;
const HANDOFF_RE = new RegExp(String.raw`\b${HANDOFF_WORD}\b`, "i");
const HANDOFF_LEAD = String.raw`(?:ok|okay|alright|cool|great|thanks|thx|now|then|also|and|so|please|pls|plz|kindly|lets|let's|can you|could you|can u|could u|go ahead and|go ahead)[\s,.:;!-]+`;
const HANDOFF_COMMAND_RE = new RegExp(String.raw`^(?:${HANDOFF_LEAD})*${HANDOFF_WORD}\b`, "i");

function isHandoffRequest(text: string): boolean {
  return HANDOFF_RE.test(text.trim());
}

const HANDOFF_REDO_RE =
  /\b(?:re-?do|re-?run|re-?generate|re-?build|re-?compile|re-?make|re-?create|re-?write|refresh|update|again|another|new|fresh|updated)\b/i;

function isHandoffRedo(text: string): boolean {
  return HANDOFF_REDO_RE.test(text.trim());
}
const FOCUS_LEAD_RE = /^[\s,.:;!?\-–—]+/;
const MAX_FOCUS_CHARS = 500;

function parseHandoffFocus(text: string): string | undefined {
  const trimmed = text.trim();
  const rest = HANDOFF_COMMAND_RE.test(trimmed)
    ? trimmed.replace(HANDOFF_COMMAND_RE, "").replace(FOCUS_LEAD_RE, "").trim()
    : trimmed;
  return rest ? rest.slice(0, MAX_FOCUS_CHARS) : undefined;
}

function parseCardTime(text: string, label: "Started" | "Ended"): string | undefined {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2}) ([+-]\\d{2}:\\d{2})`);
  const m = text.match(re);
  if (!m) return undefined;
  const [, date, time, offset] = m;
  const iso = new Date(`${date}T${time}${offset}`).toISOString();
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function extractCardText(card: any): string {
  const walk = (els: any[]): string[] =>
    els.flatMap((el) =>
      el?.tag === "collapsible_panel"
        ? [el?.header?.title?.content ?? "", ...walk(el?.elements ?? [])]
        : [el?.content ?? el?.text?.content ?? ""],
    );
  return walk(card?.body?.elements ?? card?.elements ?? [])
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractUserMessages(
  items: ThreadItem[],
  excludeMessageId?: string,
): { messageId: string; text: string; imageKeys: string[] }[] {
  const out: { messageId: string; text: string; imageKeys: string[] }[] = [];
  for (const it of items) {
    if (it.messageId === excludeMessageId) continue;
    if (it.senderType === "app") continue;
    if (!it.content) continue;
    if (it.msgType !== "text" && it.msgType !== "post" && it.msgType !== "image") continue;
    const { text, imageKeys } = parseMessageBody(it.msgType, it.content);
    if (!text && imageKeys.length === 0) continue;
    out.push({ messageId: it.messageId, text, imageKeys });
  }
  return out;
}

function silentTurn(text: string, imageCount: number): string {
  const body = text || (imageCount ? "(image only)" : "(empty message)");
  return `Another message in this Lark thread, recorded for context. Nobody asked you to act on it, so do not reply to it now. A later message can put it back in scope.\n\n${untrusted("thread_message", body)}`;
}

async function recordSilently(threadKey: string, msg: IncomingMessage): Promise<void> {
  await recordNote(threadKey, silentTurn(msg.text, msg.imageKeys.length)).catch((e) =>
    log.warn("skipped-message record failed", { thread: threadKey, error: String(e) }),
  );
}

function botWasInvited(items: ThreadItem[], botOpenId: string): boolean {
  if (!botOpenId) return false;
  return items.some((it) => it.senderType !== "app" && (it.mentionedOpenIds ?? []).includes(botOpenId));
}

function threadStartedByBot(items: ThreadItem[]): boolean {
  return items[0]?.senderType === "app";
}

function pendingUserMessages(
  items: ThreadItem[],
  excludeMessageId?: string,
): { messageId: string; text: string; imageKeys: string[] }[] {
  let lastBot = -1;
  items.forEach((it, i) => {
    if (it.senderType === "app") lastBot = i;
  });
  return extractUserMessages(items.slice(lastBot + 1), excludeMessageId);
}

const NUDGE_WORDS = new Set(
  `a above agent ahead ans answer anser any asnwer bot can check chime comment confirm could elaborate
   explain go help here hey hi idea ideas in input it kindly me now on opinion please pls plz proceed
   reply respond response sre take that this thought thoughts u update us verify view views wdyt weigh
   you your`.split(/\s+/),
);
const MAX_NUDGE_WORDS = 4;

function isBareNudge(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > MAX_NUDGE_WORDS) return false;
  return words.every((w) => NUDGE_WORDS.has(w));
}

function priorContentText(prior: Message[]): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v);
  };
  for (const m of prior) if ("content" in m) walk(m.content);
  return parts.join("\n");
}

function unseenUserTexts(prior: Message[], candidates: string[]): string[] {
  const seen = priorContentText(prior);
  return candidates.filter((t) => t.length > 0 && !seen.includes(t));
}

function senderIdentity(it: ThreadItem): string {
  const identity = {
    role: it.senderType === "app" ? "agent" : "user",
    senderType: it.senderType,
    senderId: it.senderId,
    senderIdType: it.senderIdType,
    senderName: it.senderName,
    senderI18nNames: it.senderI18nNames,
    senderTenantKey: it.senderTenantKey,
    openBotId: it.openBotId,
  };
  return JSON.stringify(identity, (_key, value) => (value === undefined ? undefined : value));
}

type AlertWindow = Omit<AlertMeta, "complete" | "alertEndedAt"> & { alertEndedAt?: string };

async function rebuildPriorFromThread(
  threadId: string,
  preFetched?: ThreadItem[],
): Promise<{ history: string; window: AlertWindow }> {
  const items = preFetched ?? (await listThreadMessages(threadId));
  const lines: string[] = [];
  let alertName = "prior alert";
  let alertStartedAt: string | undefined;
  let alertEndedAt: string | undefined;
  for (const it of items) {
    if (!it.content) continue;
    let content = it.content;
    try {
      const c = JSON.parse(it.content);
      if (it.msgType === "interactive") {
        const cardText = extractCardText(c);
        const titleMatch = (c.header?.title?.content ?? "").match(/^\[(?:OPEN|CLOSED)\]\s*(.+)$/);
        const m = titleMatch ?? cardText.match(/^#?\s*\[(?:OPEN|CLOSED)\]\s*(.+)$/m);
        if (m) alertName = m[1].trim();
        if (!alertStartedAt) alertStartedAt = parseCardTime(cardText, "Started");
        if (!alertEndedAt) alertEndedAt = parseCardTime(cardText, "Ended");
      } else if (it.msgType === "text" || it.msgType === "post") {
        content = parseMessageBody(it.msgType, it.content).text || it.content;
      }
    } catch {}
    lines.push(`[sender=${senderIdentity(it)} type=${it.msgType ?? "unknown"}] ${content}`);
  }
  const transcript = lines.join("\n---\n");
  const history = `Earlier discussion in this Lark thread (session state was lost; reconstructed from chat history):\n\n${untrusted("thread_history", transcript)}`;
  return { history, window: { alertName, alertStartedAt, alertEndedAt } };
}

export async function handleLarkMessage(msg: IncomingMessage): Promise<void> {
  if (!msg.threadId) {
    log.info("lark message dropped: not in a topic thread", { chat: msg.chatId, hasRoot: !!msg.rootId });
    return;
  }
  const botOpenId = state().botOpenId;
  if (botOpenId && msg.mentionedOpenIds.length > 0 && !msg.mentionedOpenIds.includes(botOpenId)) {
    log.info("lark message dropped: mentions don't include bot", {
      chat: msg.chatId,
      mentions: msg.mentionedOpenIds,
    });
    return;
  }
  const threadKey = msg.rootId ?? msg.parentId;
  if (!threadKey) return;

  const { cfg } = state();
  let threadItems: ThreadItem[] | undefined;
  try {
    const cached = await state().threadMessages.get(msg.threadId);
    if (cached) {
      threadItems = cached;
    } else {
      threadItems = await listThreadMessages(msg.threadId);
      await state()
        .threadMessages.set(msg.threadId, threadItems)
        .catch(() => {});
    }
  } catch (e) {
    log.warn("thread list failed; proceeding without context", { thread: threadKey, error: String(e) });
  }

  const known = (await threadConversation(threadKey)) !== undefined;
  if (!known) {
    log.info("no stored thread; rebuilding from Lark history", { thread: threadKey, threadId: msg.threadId });
    try {
      const rebuilt = await rebuildPriorFromThread(msg.threadId, threadItems);
      await createThread(threadKey, {
        name: rebuilt.window.alertName,
        source: "lark-followup",
        severity: "info",
        startedAt: rebuilt.window.alertStartedAt,
        endedAt: rebuilt.window.alertEndedAt,
      });
      await recordNote(threadKey, rebuilt.history);
    } catch (e) {
      log.error("thread rebuild failed", e, { thread: threadKey });
      return;
    }
  }
  const meta = (await threadMeta(threadKey))!;
  if (known && !meta.alertStartedAt) {
    try {
      const { window } = await rebuildPriorFromThread(msg.threadId, threadItems);
      await patchThreadAlert(threadKey, { startedAt: window.alertStartedAt, endedAt: window.alertEndedAt });
      log.info("backfilled alert window from card", { thread: threadKey, ...window });
    } catch (e) {
      log.warn("card timestamp backfill failed", { thread: threadKey, error: String(e) });
    }
  }
  log.info("lark message received", {
    thread: threadKey,
    text: msg.text.slice(0, 80),
    images: msg.imageKeys.length,
    rebuilt: !known,
    sender: msg.senderId,
  });

  if (isHandoffRequest(msg.text)) {
    const focus = parseHandoffFocus(msg.text);
    log.info("handoff requested", { thread: threadKey, rebuilt: !known, focus, redo: isHandoffRedo(msg.text) });
    const reactionId = await addReaction(msg.messageId).catch(() => "");
    const compiled = await ensureHandoff(
      threadKey,
      cfg,
      (await threadMeta(threadKey)) ?? meta,
      await threadTranscript(threadKey),
      focus,
      isHandoffRedo(msg.text),
    );
    const url = handoffUrl(threadKey);
    const reply = url ?? "Handoff link unavailable (OPSREMEDY_SESSION_SECRET or publicBaseUrl not set).";
    await replyMessage(threadKey, { markdown: reply });
    await removeReaction(msg.messageId, reactionId);
    log.info("handoff posted", { thread: threadKey, linked: !!url, compiled: !!compiled });
    return;
  }

  const botMentioned = botOpenId ? msg.mentionedOpenIds.includes(botOpenId) : false;
  const priorUserMessages = extractUserMessages(threadItems ?? [], msg.messageId);
  const pending = pendingUserMessages(threadItems ?? [], msg.messageId);

  const items = threadItems ?? [];
  if (!botMentioned && !threadStartedByBot(items) && !botWasInvited(items, botOpenId)) {
    await recordSilently(threadKey, msg);
    log.info("lark message dropped: bot not invited to this human-started thread", {
      thread: threadKey,
      botKnown: !!botOpenId,
    });
    return;
  }
  const priorUserTexts = priorUserMessages.map((m) => m.text).filter(Boolean);
  const decision = botMentioned ? "REPLY" : await triage(msg.text, priorUserTexts, msg.imageKeys.length > 0);
  if (decision === "SKIP") {
    await recordSilently(threadKey, msg);
    log.info("lark message triaged out", { thread: threadKey, recorded: true });
    return;
  }

  let question = msg.text;
  let imageSourceId = msg.messageId;
  let imageKeys = msg.imageKeys;
  let adopted = false;
  if (isBareNudge(question) && imageKeys.length === 0) {
    const source = pending.length > 0 ? pending : priorUserMessages.slice(-1);
    const texts = source.map((p) => p.text).filter(Boolean);
    const carrier = [...source].reverse().find((p) => p.imageKeys.length > 0);
    if (texts.length > 0) question = texts.join("\n");
    if (carrier) {
      imageKeys = carrier.imageKeys;
      imageSourceId = carrier.messageId;
    }
    adopted = texts.length > 0 || !!carrier;
    if (adopted)
      log.info("nudge-only mention: adopting unanswered user messages", {
        thread: threadKey,
        nudge: msg.text.slice(0, 40),
        adopted: source.length,
        text: question.slice(0, 80),
        images: imageKeys.length,
      });
  }

  const images: ImageContent[] = [];
  let unreadableImages = 0;
  for (const key of imageKeys) {
    try {
      const img = await downloadImage(imageSourceId, key);
      images.push(img);
      log.info("image attached", {
        thread: threadKey,
        mimeType: img.mimeType,
        kb: Math.round((img.data.length * 3) / 4 / 1024),
      });
    } catch (e) {
      unreadableImages++;
      log.warn("image download failed", { thread: threadKey, key, error: String(e) });
    }
  }
  const isMaintainer = !!msg.senderId && (cfg.maintainerOpenIds ?? []).some((id) => id.trim() === msg.senderId);
  if (isMaintainer) log.info("maintainer follow-up", { thread: threadKey, sender: msg.senderId });

  const reactionId = await addReaction(msg.messageId).catch(() => "");

  let userText = question || (images.length ? "(attached image)" : "");
  if (adopted) {
    userText = `The user tagged you and asked you to answer their own message below. Any earlier note that told you to stay out of it no longer applies.\n\n${userText}`;
  }
  if (unreadableImages > 0) {
    userText += `\n\n(The user attached ${unreadableImages} image that failed to download. Say so instead of guessing what it showed.)`;
  }
  const unseen = new Set(unseenUserTexts(await threadTranscript(threadKey), priorUserTexts.slice(-6)));
  const pendingTexts = new Set(pending.map((p) => p.text));
  const inScope = priorUserTexts
    .slice(-6)
    .filter((t) => (unseen.has(t) || pendingTexts.has(t)) && !question.includes(t));
  if (inScope.length > 0) {
    userText = [
      "Messages posted in this Lark thread that you have not answered yet. Earlier context can mark them as not needing a reply. That no longer holds, because the user asks for them now:",
      untrusted("thread_history", inScope.join("\n")),
      userText,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    log.info("replayed unanswered thread messages", { thread: threadKey, count: inScope.length });
  }
  if (meta.complete !== true) {
    userText +=
      "\n\n(Investigation still running, will post its own diagnosis separately. " +
      "Answer from the evidence above — don't re-run queries — and flag anything preliminary.)";
  }
  await startReply((await threadConversation(threadKey))!, {
    threadKey,
    text: userText,
    images,
    maintainer: isMaintainer,
    messageId: msg.messageId,
    reactionId,
  });
  log.info("lark message queued for reply", { thread: threadKey, images: images.length });
}
