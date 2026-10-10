import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { sendCard, patchCard, findCardInChat, replyMessage } from "../lark/client.ts";
import { track } from "../utils/inflight.ts";
import { progressCard } from "../lark/card.ts";
import { investigationSlots, startInvestigation } from "../harness/investigation.ts";
import { createThread, patchThreadAlert } from "../harness/threads.ts";
import type { Alert } from "../alert.ts";
import type { GCPWebhookPayload, Incident } from "./incident.ts";
import { incidentToAlert, alertKey, findSubject } from "./incident.ts";
import type { AlertGroup } from "../session/store.ts";
import { buildAlertCard } from "./card.ts";
import { sessionUrl } from "../session/link.ts";
import { userFacingError } from "../utils/model-error.ts";

const PENDING_CARD = "";
const PENDING_CLAIM_TTL_SECONDS = 120;

async function locateCard(inc: Incident): Promise<string> {
  const mapped = await state().incidents.get(inc.incident_id);
  if (mapped) return mapped;
  const group = await state()
    .alertGroups.get(alertKey(inc))
    .catch(() => undefined);
  return group?.rootMsgId && group.incidentId === inc.incident_id ? group.rootMsgId : "";
}

async function findOpenCardInChat(chatId: string, inc: Incident): Promise<string> {
  const subject = findSubject(inc)?.value;
  try {
    return await findCardInChat(chatId, [`[OPEN] ${inc.policy_name}`, ...(subject ? [subject] : [])]);
  } catch (e) {
    log.warn("findCardInChat failed", { incident: inc.incident_id, error: String(e) });
    return "";
  }
}

async function beginInvestigation(alert: Alert, rootMsgId: string, incidentId: string): Promise<void> {
  const slots = investigationSlots();
  const queuedAhead = slots.queued();
  const queued = queuedAhead > 0 || slots.active() >= state().cfg.agent.maxConcurrent;
  const progressMsgId = await replyMessage(rootMsgId, {
    card: progressCard(
      queued
        ? `Investigation queued (${queuedAhead + 1} ahead, ${slots.active()} running)…`
        : "Starting investigation…",
    ),
  }).catch((e) => {
    log.warn("progress card send failed", { root: rootMsgId, error: String(e) });
    return "";
  });
  const conversationId = await createThread(rootMsgId, alert);
  await startInvestigation(conversationId, { threadKey: rootMsgId, incidentId, progressMsgId });
  log.info("investigation started", { alert: alert.name, root: rootMsgId });
}

async function handleClose(chatId: string, inc: Incident): Promise<void> {
  if (inc.ended_at) {
    const endedAt = new Date(inc.ended_at * 1000).toISOString();
    try {
      await state().incidentMeta.set(inc.incident_id, { endedAt });
    } catch (e) {
      log.warn("incidentMeta write failed", { incident: inc.incident_id, error: String(e) });
    }
  }
  const msgId = (await locateCard(inc)) || (await findOpenCardInChat(chatId, inc));
  const card = buildAlertCard(inc, msgId ? sessionUrl(msgId) : undefined);
  if (msgId && inc.ended_at) {
    try {
      await patchThreadAlert(msgId, { endedAt: new Date(inc.ended_at * 1000).toISOString() });
      log.info("session stamped with alertEndedAt", { incident: inc.incident_id, root: msgId });
    } catch (e) {
      log.warn("session stamp failed", { incident: inc.incident_id, error: String(e) });
    }
  }
  if (msgId) {
    try {
      await patchCard(msgId, card);
      await state().incidents.delete(inc.incident_id);
      await state().incidentMeta.delete(inc.incident_id);
      await touchGroupOnClose(inc, msgId);
      log.info("card patched to closed", { incident: inc.incident_id, root: msgId });
      return;
    } catch (e) {
      log.warn("patch failed; falling back to new card", { incident: inc.incident_id, error: String(e) });
    }
  }
  const lostOpen = !msgId;
  if (lostOpen && !(await state().incidents.setIfAbsent(inc.incident_id, PENDING_CARD, PENDING_CLAIM_TTL_SECONDS))) {
    log.info("closed card claim lost to a concurrent delivery", { incident: inc.incident_id });
    return;
  }
  let newId: string;
  try {
    newId = await sendCard(chatId, card);
    log.info("closed card sent (no open found)", { incident: inc.incident_id, root: newId, investigate: lostOpen });
  } catch (e) {
    log.error("send closed card failed", e, { incident: inc.incident_id });
    if (lostOpen)
      await state()
        .incidents.delete(inc.incident_id)
        .catch(() => {});
    return;
  }
  if (!lostOpen) return;
  const alert = incidentToAlert(inc);
  try {
    await state().incidents.set(inc.incident_id, newId);
    await state().alertGroups.setIfAbsent(alertKey(inc), {
      rootMsgId: newId,
      incidentId: inc.incident_id,
      opens: 1,
      firstOpenedAt: alert.startedAt ?? "",
    });
  } catch (e) {
    log.warn("closed card bookkeeping failed", { incident: inc.incident_id, error: String(e) });
  }
  await startThread(inc, alert, newId);
}

async function touchGroupOnClose(inc: Incident, rootMsgId: string): Promise<void> {
  const key = alertKey(inc);
  try {
    const group = await state().alertGroups.get(key);
    if (!group) return;
    await state().alertGroups.set(key, { ...group, rootMsgId, incidentId: inc.incident_id });
  } catch (e) {
    log.warn("alert group refresh failed", { incident: inc.incident_id, key, error: String(e) });
  }
}

async function reuseCard(inc: Incident, key: string, group: AlertGroup): Promise<void> {
  const next: AlertGroup = { ...group, incidentId: inc.incident_id, opens: group.opens + 1 };
  await state().alertGroups.set(key, next);
  await state().incidents.set(inc.incident_id, group.rootMsgId);
  await patchThreadAlert(group.rootMsgId, { endedAt: undefined }).catch((e) =>
    log.warn("re-open meta clear failed", { incident: inc.incident_id, error: String(e) }),
  );
  try {
    await patchCard(group.rootMsgId, buildAlertCard(inc, sessionUrl(group.rootMsgId), next));
  } catch (e) {
    log.warn("re-open patch failed", { incident: inc.incident_id, root: group.rootMsgId, error: String(e) });
    await state()
      .incidents.delete(inc.incident_id)
      .catch(() => {});
    await state()
      .alertGroups.set(key, group)
      .catch(() => {});
    return;
  }
  log.info("alert re-opened inside flap window; card reused", {
    incident: inc.incident_id,
    key,
    opens: next.opens,
    root: group.rootMsgId,
  });
}

async function handleOpen(chatId: string, inc: Incident): Promise<void> {
  const existing = await locateCard(inc);
  if (existing) {
    log.info("alert card already exists; reusing thread", { incident: inc.incident_id, root: existing });
    return;
  }
  if (!(await state().incidents.setIfAbsent(inc.incident_id, PENDING_CARD, PENDING_CLAIM_TTL_SECONDS))) {
    log.info("alert card claim lost to a concurrent delivery", { incident: inc.incident_id });
    return;
  }
  const key = alertKey(inc);
  const alert = incidentToAlert(inc);
  const claimed = await state().alertGroups.setIfAbsent(
    key,
    { rootMsgId: PENDING_CARD, incidentId: inc.incident_id, opens: 1, firstOpenedAt: alert.startedAt ?? "" },
    PENDING_CLAIM_TTL_SECONDS,
  );
  if (!claimed) {
    const group = await state().alertGroups.get(key);
    if (group?.rootMsgId) return reuseCard(inc, key, group);
    log.info("alert group claim lost to a concurrent delivery", { incident: inc.incident_id, key });
    await state()
      .incidents.delete(inc.incident_id)
      .catch(() => {});
    return;
  }
  let rootMsgId = "";
  try {
    rootMsgId = await sendCard(chatId, buildAlertCard(inc));
    await state().incidents.set(inc.incident_id, rootMsgId);
    await state().alertGroups.set(key, {
      rootMsgId,
      incidentId: inc.incident_id,
      opens: 1,
      firstOpenedAt: alert.startedAt ?? "",
    });
    log.info("alert card sent", { incident: inc.incident_id, key, root: rootMsgId });
  } catch (e) {
    log.error("send alert card failed", e, { incident: inc.incident_id });
    await state()
      .incidents.delete(inc.incident_id)
      .catch(() => {});
    await state()
      .alertGroups.delete(key)
      .catch(() => {});
    return;
  }
  await startThread(inc, alert, rootMsgId);
}

async function startThread(inc: Incident, alert: Alert, rootMsgId: string): Promise<void> {
  const url = sessionUrl(rootMsgId);
  if (url) {
    try {
      await patchCard(rootMsgId, buildAlertCard(inc, url));
    } catch (e) {
      log.warn("patch card with session link failed", { incident: inc.incident_id, error: String(e) });
    }
  }
  try {
    await beginInvestigation(alert, rootMsgId, inc.incident_id);
  } catch (e) {
    log.error("investigation start failed", e, { incident: inc.incident_id, root: rootMsgId });
    await replyMessage(rootMsgId, { text: `⚠️ Investigation failed to start: ${userFacingError(String(e))}` }).catch(
      () => {},
    );
  }
}

const WEBHOOK_TOKEN = process.env.OPSREMEDY_WEBHOOK_TOKEN ?? "";
if (!WEBHOOK_TOKEN) log.warn("OPSREMEDY_WEBHOOK_TOKEN not set: /alert/:chatId will reject all requests (401)");

export async function handleAlertWebhook(req: Request & { params: { chatId: string } }): Promise<Response> {
  const chatId = req.params.chatId;
  if (!chatId) return Response.json({ error: "missing chat_id" }, { status: 400 });
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
    log.warn("webhook auth rejected", { chat: chatId });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: GCPWebhookPayload;
  try {
    payload = (await req.json()) as GCPWebhookPayload;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const inc = payload?.incident;
  if (!inc?.incident_id || !inc?.policy_name) {
    return Response.json({ error: "invalid incident payload" }, { status: 400 });
  }

  log.info("gcp webhook received", {
    policy: inc.policy_name,
    state: inc.state,
    incident: inc.incident_id,
    chat: chatId,
    docLinks: inc.documentation?.links?.length ?? 0,
  });

  const isClose = inc.state === "closed";
  track(
    (isClose ? handleClose(chatId, inc) : handleOpen(chatId, inc)).catch((e) =>
      log.error("webhook handler failed", e, { incident: inc.incident_id }),
    ),
  );

  return Response.json({ ok: true, action: isClose ? "close" : "open" }, { status: 202 });
}
