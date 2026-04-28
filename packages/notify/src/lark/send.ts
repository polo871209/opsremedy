import * as lark from "@larksuiteoapi/node-sdk";
import type { CardEnvelope, LarkConfig } from "../types.ts";

/**
 * Subset of @larksuiteoapi/node-sdk's Client surface we depend on. Lets tests
 * inject a fake without spinning up the real SDK (which constructs an axios
 * instance + token cache). The real `lark.Client` satisfies this trivially.
 */
export interface LarkSendClient {
  im: {
    message: {
      create: (args: {
        params: { receive_id_type: string };
        data: {
          receive_id: string;
          msg_type: string;
          content: string;
          uuid?: string;
        };
      }) => Promise<{ code: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
}

let cachedClient: LarkSendClient | null = null;
let cachedKey = "";
let injected: LarkSendClient | null = null;

/** Reset cached SDK client. Used by tests to swap implementations. */
export function resetLarkClient(): void {
  cachedClient = null;
  cachedKey = "";
  injected = null;
}

/** Inject a fake client (tests). Bypasses cfg-keyed cache until reset. */
export function setLarkClient(client: LarkSendClient): void {
  injected = client;
}

function getClient(cfg: LarkConfig): LarkSendClient {
  if (injected) return injected;
  const key = `${cfg.appId}:${cfg.domain}`;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedKey = key;
  cachedClient = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: cfg.domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark,
  }) as unknown as LarkSendClient;
  return cachedClient;
}

export interface SendResult {
  messageId: string;
}

/**
 * Send a card via the bot app's `im.v1.messages.create`. The SDK handles
 * tenant_access_token caching, refresh, and domain routing. We only own the
 * stringification of `content` and the uuid for idempotency.
 */
export async function sendLarkCard(cfg: LarkConfig, card: CardEnvelope, uuid: string): Promise<SendResult> {
  const client = getClient(cfg);
  const res = await client.im.message.create({
    params: { receive_id_type: cfg.receiveIdType },
    data: {
      receive_id: cfg.receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
      uuid: uuid.slice(0, 50),
    },
  });
  if (res.code !== 0) {
    throw new Error(`lark send failed: code=${res.code} msg=${res.msg ?? "unknown"}`);
  }
  return { messageId: res.data?.message_id ?? "" };
}

/**
 * Build a 50-char-max idempotency key. Investigations re-run within ~15 min
 * for the same alert collapse to a single message; later runs send fresh.
 * 1-hour Lark dedup window applies after this.
 */
export function buildSendUuid(alertId: string, now: number = Date.now()): string {
  const bucket = Math.floor(now / 900_000); // 15-min buckets
  const raw = `${alertId}:${bucket}`;
  return raw.slice(0, 50);
}
