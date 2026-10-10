import * as lark from "@larksuiteoapi/node-sdk";
import { parseIncoming, type IncomingMessage } from "./event.ts";
import { log, makeSdkLogger } from "../utils/logger.ts";
import { track } from "../utils/inflight.ts";

export interface WSOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingMessage) => Promise<void>;
}

// EventDispatcher exposes no "unmatched event" hook, so this patches its private `handle` method through a cast.
function installRawEventLogger(dispatcher: lark.EventDispatcher): void {
  const patchable = dispatcher as unknown as { handle?: (data: unknown) => Promise<unknown> };
  const origHandle = patchable.handle;
  if (typeof origHandle !== "function") return;
  patchable.handle = async function (this: unknown, data: unknown) {
    const d = data as { header?: { event_type?: string }; type?: string; event?: unknown };
    log.info("lark ws raw event", { type: d?.header?.event_type ?? d?.type, hasEvent: !!d?.event });
    return origHandle.call(this, data);
  };
}

// Set on SIGTERM: the SDK exposes no way to close the socket, so instead we stop
// acking. An un-acked event is redelivered by Lark and lands on a live replica,
// where the old pod would have started work the shutdown drain can no longer wait for.
let draining = false;
export function stopWS(): void {
  draining = true;
}

export function startWS(opts: WSOptions): void {
  const ws = new lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: lark.Domain.Lark,
    loggerLevel: lark.LoggerLevel.info,
    logger: makeSdkLogger("lark-ws"),
  });

  // Dedup: Lark retries event delivery if we don't ack fast. Investigation can
  // take 10-60s, so we MUST ack immediately and run async. Track recent
  // message_ids to drop duplicates from retries.
  const seen = new Set<string>();

  // Without its own logger the dispatcher keeps the SDK default, which writes
  // `[info]: [ "..." ]` to the console and breaks JSON parsing in Cloud Logging.
  const dispatcher = new lark.EventDispatcher({
    loggerLevel: lark.LoggerLevel.info,
    logger: makeSdkLogger("lark-dispatch"),
  }).register({
    "im.message.receive_v1": async (event: unknown) => {
      const eMeta = event as {
        message?: {
          message_id?: string;
          chat_id?: string;
          message_type?: string;
          chat_type?: string;
          mentions?: unknown[];
        };
      };
      log.info("lark ws im.message.receive_v1", {
        messageId: eMeta.message?.message_id,
        chatId: eMeta.message?.chat_id,
        msgType: eMeta.message?.message_type,
        chatType: eMeta.message?.chat_type,
        mentions: eMeta.message?.mentions?.length ?? 0,
      });
      if (draining) throw new Error("opsremedy shutting down; leaving event unacked for redelivery");
      const msg = parseIncoming(event);
      if (!msg) {
        log.warn("lark ws parseIncoming returned null", { event });
        return { success: true };
      }
      if (seen.has(msg.messageId)) {
        log.info("lark ws duplicate dropped", { messageId: msg.messageId });
        return { success: true };
      }
      seen.add(msg.messageId);
      setTimeout(() => seen.delete(msg.messageId), 10 * 60 * 1000).unref();

      track(
        opts.onMessage(msg).catch((e) => {
          log.error("lark ws handler failed", e, { thread: msg.rootId ?? msg.parentId });
        }),
      );
      return { success: true };
    },
    // We don't act on reactions; register no-op handlers so the SDK doesn't warn
    // "no handle" for every reaction on a bot message (subscribed at the app level).
    "im.message.reaction.created_v1": async () => ({ success: true }),
    "im.message.reaction.deleted_v1": async () => ({ success: true }),
  });
  installRawEventLogger(dispatcher);
  ws.start({ eventDispatcher: dispatcher });
  log.info("lark ws started");
}
