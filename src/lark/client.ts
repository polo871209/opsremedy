import * as lark from "@larksuiteoapi/node-sdk";
import { makeSdkLogger } from "../utils/logger.ts";

let _client: lark.Client | undefined;

export function initClient(appId: string, appSecret: string): lark.Client {
  if (_client) return _client;
  _client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
    logger: makeSdkLogger("lark-sdk"),
    loggerLevel: lark.LoggerLevel.info,
  });
  return _client;
}

function client(): lark.Client {
  if (!_client) throw new Error("lark client not initialized — call initClient() first");
  return _client;
}

function unwrap<T>(res: { code?: number; msg?: string; data?: T }): T {
  if (res.code && res.code !== 0) throw new Error(`lark: code=${res.code} msg=${res.msg}`);
  return res.data as T;
}

export async function sendCard(chatId: string, card: unknown): Promise<string> {
  const res = await client().im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
  return unwrap<{ message_id?: string }>(res).message_id ?? "";
}

export async function patchCard(messageId: string, card: unknown): Promise<void> {
  const res = await client().im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
  unwrap(res);
}

// Raw fetch because the Lark SDK has no typed call for /bot/v3/info.
export async function getBotOpenId(appId: string, appSecret: string): Promise<string> {
  const base = "https://open.larksuite.com/open-apis";
  const tokRes = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  const tok = (await tokRes.json()) as { tenant_access_token?: string };
  if (!tok.tenant_access_token) throw new Error("tenant_access_token missing");
  const infoRes = await fetch(`${base}/bot/v3/info`, {
    headers: { authorization: `Bearer ${tok.tenant_access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const info = (await infoRes.json()) as { bot?: { open_id?: string } };
  return info?.bot?.open_id ?? "";
}

export async function findCardInChat(chatId: string, needles: string[]): Promise<string> {
  const res = await client().im.v1.message.list({
    params: {
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeDesc",
      page_size: 10,
    },
  });
  if (res.code && res.code !== 0) throw new Error(`lark list: code=${res.code} msg=${res.msg}`);
  const items = (res.data?.items ?? []) as { message_id?: string; body?: { content?: string } }[];
  for (const item of items) {
    const content = item.body?.content ?? "";
    if (item.message_id && needles.every((n) => content.includes(n))) return item.message_id;
  }
  return "";
}

export interface ThreadItem {
  messageId: string;
  senderType?: string;
  senderId?: string;
  senderIdType?: string;
  senderName?: string;
  senderI18nNames?: { zh_cn?: string; en_us?: string; ja_jp?: string };
  senderTenantKey?: string;
  openBotId?: string;
  msgType?: string;
  content?: string;
  createTime?: string;
  mentionedOpenIds?: string[];
}

export async function listThreadMessages(threadId: string, pageSize = 50): Promise<ThreadItem[]> {
  const threadItems: ThreadItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client().im.v1.message.list({
      params: {
        container_id_type: "thread",
        container_id: threadId,
        sort_type: "ByCreateTimeAsc",
        page_size: pageSize,
        page_token: pageToken,
        card_msg_content_type: "user_card_content",
        with_sender_name: true,
      },
    });
    if (res.code && res.code !== 0) throw new Error(`lark thread list: code=${res.code} msg=${res.msg}`);
    const items = res.data?.items ?? [];
    threadItems.push(
      ...items
        .filter((i) => i.message_id)
        .map((i) => ({
          messageId: i.message_id!,
          senderType: i.sender?.sender_type,
          senderId: i.sender?.id,
          senderIdType: i.sender?.id_type,
          senderName: i.sender?.sender_name,
          senderI18nNames: i.sender?.sender_i18n_names,
          senderTenantKey: i.sender?.tenant_key,
          openBotId: i.sender?.open_bot_id,
          msgType: i.msg_type,
          content: i.body?.content,
          createTime: i.create_time,
          mentionedOpenIds: (i.mentions ?? []).map((m) => m?.id ?? "").filter(Boolean),
        })),
    );
    if (!res.data?.has_more) break;
    if (!res.data.page_token || res.data.page_token === pageToken) {
      throw new Error("lark thread list: missing next page token");
    }
    pageToken = res.data.page_token;
  } while (true);
  return threadItems;
}

export async function addReaction(messageId: string, emojiType = "OneSecond"): Promise<string> {
  try {
    const res = await client().im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    return unwrap<{ reaction_id?: string }>(res).reaction_id ?? "";
  } catch {
    return "";
  }
}

// The four types Anthropic accepts. Anything else makes the whole request fail
// with a 400, so an unreadable image must never reach the model.
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// Anthropic caps one image at 5 MB of base64, which is ~3.75 MB of bytes.
const MAX_IMAGE_BYTES = 3_500_000;

// Read the type out of the bytes. Lark serves screenshots as
// application/octet-stream often enough that the header alone is not evidence.
function sniffImageType(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export async function downloadImage(
  messageId: string,
  fileKey: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const res = await client().im.v1.messageResource.get({
    params: { type: "image" },
    path: { message_id: messageId, file_key: fileKey },
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.getReadableStream()) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + part.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `lark image ${fileKey}: over ${Math.round(MAX_IMAGE_BYTES / 1024)} KB, which exceeds the model limit`,
      );
    }
    size += part.length;
    chunks.push(part);
  }
  const buf = Buffer.concat(chunks, size);
  if (buf.length === 0) throw new Error(`lark image ${fileKey}: empty body`);
  const header = String(res.headers?.["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const mimeType = sniffImageType(buf) ?? (MODEL_IMAGE_TYPES.has(header) ? header : undefined);
  if (!mimeType) throw new Error(`lark image ${fileKey}: unsupported type (header "${header || "none"}")`);
  return { type: "image", data: buf.toString("base64"), mimeType };
}

export async function removeReaction(messageId: string, reactionId: string): Promise<void> {
  if (!reactionId) return;
  try {
    await client().im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {}
}

// The Lark `md` post node renders bold, links, lists and code, but no tables and no headings.
export async function replyMessage(
  messageId: string,
  opts: { text?: string; markdown?: string; card?: unknown },
): Promise<string> {
  const [msgType, content] =
    opts.card !== undefined
      ? ["interactive", opts.card]
      : opts.markdown !== undefined
        ? ["post", { zh_cn: { content: [[{ tag: "md", text: opts.markdown }]] } }]
        : ["text", { text: opts.text ?? "" }];
  const res = await client().im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: msgType,
      content: JSON.stringify(content),
      reply_in_thread: true,
    },
  });
  return unwrap<{ message_id?: string }>(res).message_id ?? "";
}
