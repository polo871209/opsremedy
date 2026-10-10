import { loadConfig } from "./config.ts";
import { initClient, getBotOpenId } from "./lark/client.ts";
import { startWS, stopWS } from "./lark/ws.ts";
import {
  makeIncidentStore,
  makeIncidentMetaStore,
  makeThreadMessagesCache,
  makeAlertGroupStore,
} from "./session/store.ts";
import { sweepExpired } from "./session/sqlite-store.ts";
import { closeHarness, openHarness, pruneHarness } from "./harness/harness.ts";
import type { ThreadItem } from "./lark/client.ts";
import { initState, setBotOpenId } from "./state.ts";
import { log } from "./utils/logger.ts";
import { handleAlertWebhook } from "./gcp/webhook.ts";
import { handleSessionDump } from "./session/dump.ts";
import { handleHandoffDump } from "./session/handoff.ts";
import { handleLarkMessage } from "./lark/handler.ts";
import { drain, DRAIN_TIMEOUT_MS } from "./utils/inflight.ts";
import { startTokenRefresh } from "./utils/token-refresh.ts";

const cfg = loadConfig("config.yaml");
const port = Number(process.env.PORT ?? 8080);
const larkAppId = process.env.LARK_BOT_APP_ID ?? "";
const larkAppSecret = process.env.LARK_BOT_APP_SECRET ?? "";
if (!larkAppId || !larkAppSecret) throw new Error("LARK_BOT_APP_ID and LARK_BOT_APP_SECRET must be set");

initClient(larkAppId, larkAppSecret);
let botOpenId = "";
try {
  botOpenId = await getBotOpenId(larkAppId, larkAppSecret);
  log.info("bot identity resolved", { botOpenId });
} catch (e) {
  log.error("bot identity lookup failed; follow-up replies stay off until it resolves", e);
}

function retryBotIdentity(): void {
  setTimeout(async () => {
    try {
      const id = await getBotOpenId(larkAppId, larkAppSecret);
      setBotOpenId(id);
      log.info("bot identity resolved on retry", { botOpenId: id });
    } catch (e) {
      log.warn("bot identity retry failed", { error: String(e) });
      retryBotIdentity();
    }
  }, 60_000).unref();
}
initState({
  cfg,
  incidents: makeIncidentStore(cfg.session.dbPath, cfg.session.ttlSeconds),
  incidentMeta: makeIncidentMetaStore(cfg.session.dbPath, cfg.session.ttlSeconds),
  alertGroups: makeAlertGroupStore(cfg.session.dbPath, cfg.notify.flapWindowSeconds),
  threadMessages: makeThreadMessagesCache<ThreadItem[]>(cfg.session.dbPath, 10),
  botOpenId,
});
if (!botOpenId) retryBotIdentity();
await openHarness(cfg);

const server = Bun.serve({
  port,
  routes: {
    "/healthz": () => new Response("ok"),
    "/alert/:chatId": { POST: handleAlertWebhook },
    "/s/:threadKey/:token": { GET: handleSessionDump },
    "/handoff/:threadKey/:token": { GET: handleHandoffDump },
  },
  error: (e) => {
    log.error("server error", e);
    return Response.json({ error: e.message }, { status: 500 });
  },
});

log.info("opsremedy listening", { port });

if (cfg.session.dbPath) {
  Bun.cron(
    "0 3 * * MON",
    async () => {
      try {
        const expired = sweepExpired(cfg.session.dbPath);
        const pruned = await pruneHarness(Date.now() - cfg.session.ttlSeconds * 1000);
        log.info("sqlite retention", { expired, ...pruned });
      } catch (e) {
        log.error("sqlite retention failed", e);
      }
    },
    { tz: cfg.timezone },
  );
}

startWS({ appId: larkAppId, appSecret: larkAppSecret, onMessage: handleLarkMessage });

startTokenRefresh();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { signal });
  server.stop();
  stopWS();
  const res = await drain(DRAIN_TIMEOUT_MS);
  log.info("drain done", res);
  await closeHarness();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
