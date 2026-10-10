
export interface IncomingMessage {
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  chatId: string;
  senderId: string;
  text: string;
  imageKeys: string[];
  mentionedOpenIds: string[];
}

interface EventBody {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id?: string;
    message_type?: string;
    content?: string;
    mentions?: { key?: string; name?: string; id?: { open_id?: string } }[];
  };
}

export function parseMessageBody(
  msgType: string | undefined,
  rawContent: string | undefined,
): { text: string; imageKeys: string[] } {
  let text = "";
  const imageKeys: string[] = [];
  try {
    const content = rawContent ? JSON.parse(rawContent) : {};
    if (msgType === "text") {
      text = String(content.text ?? "");
    } else if (msgType === "image") {
      if (content.image_key) imageKeys.push(String(content.image_key));
    } else if (msgType === "post") {
      const blocks = content.content ?? content?.zh_cn?.content ?? content?.en_us?.content ?? [];
      const nodes = (blocks as unknown[][]).flat() as { tag?: string; text?: string; image_key?: string }[];
      const textParts: string[] = [];
      for (const n of nodes) {
        if (n?.tag === "img" && n.image_key) imageKeys.push(String(n.image_key));
        else if (n?.text) textParts.push(n.text);
      }
      text = textParts.join(" ").trim();
    } else {
      text = JSON.stringify(content);
    }
  } catch {
    text = rawContent ?? "";
  }
  return { text: text.replace(/@_user_\d+/g, "").trim(), imageKeys };
}

export function parseIncoming(event: unknown): IncomingMessage | null {
  const e = event as EventBody;
  const m = e?.message;
  if (!m?.message_id || !m.chat_id) return null;

  const { text, imageKeys } = parseMessageBody(m.message_type, m.content);

  return {
    messageId: m.message_id,
    rootId: m.root_id,
    parentId: m.parent_id,
    threadId: m.thread_id,
    chatId: m.chat_id,
    senderId: e?.sender?.sender_id?.open_id ?? "",
    text,
    imageKeys,
    mentionedOpenIds: (m.mentions ?? []).map((x) => x?.id?.open_id ?? "").filter(Boolean),
  };
}
