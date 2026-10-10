import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { CoreV1Api, KubeConfig, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import { log } from "./logger.ts";
import { inflightCount } from "./inflight.ts";
import { clearLiveCreds, currentCreds, setLiveCreds, type Creds } from "./anthropic_token.ts";

const REFRESH_MARGIN_MS = 15 * 60_000;
const HARD_MARGIN_MS = 5 * 60_000;
const TICK_CRON = "*/5 * * * *";
const REFRESH_TIMEOUT_MS = 30_000;
const MIN_ATTEMPT_GAP_MS = 60_000;

type RefreshPlan = "wait" | "defer" | "refresh";
type TickPlan = RefreshPlan | "no-credential";

function planRefresh(expires: number, now: number, working: boolean): RefreshPlan {
  const left = expires - now;
  if (left > REFRESH_MARGIN_MS) return "wait";
  if (working && left > HARD_MARGIN_MS) return "defer";
  return "refresh";
}

function planTick(creds: { refresh?: string; expires: number }, now: number, working: boolean): TickPlan {
  if (!creds.refresh) return "no-credential";
  return planRefresh(creds.expires, now, working);
}

const ns = () => process.env.NAMESPACE ?? "opsremedy";
const secretName = () => process.env.SECRET_NAME ?? "anthropic-auth";

export function credsToSecretFields(creds: Creds): Record<string, string> {
  return {
    ANTHROPIC_OAUTH_TOKEN: creds.access,
    ANTHROPIC_REFRESH_TOKEN: creds.refresh,
    ANTHROPIC_TOKEN_EXPIRES_AT: String(creds.expires),
  };
}

export async function patchTokenSecret(creds: Creds): Promise<void> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  await core.patchNamespacedSecret(
    { name: secretName(), namespace: ns(), body: { stringData: credsToSecretFields(creds) } },
    setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch),
  );
}

export async function refreshCreds(refreshToken: string): Promise<Creds> {
  const oauth = anthropicProvider().auth.oauth;
  if (!oauth) throw new Error("anthropic provider exposes no oauth flow");
  const creds = await oauth.refresh(
    { type: "oauth", refresh: refreshToken, access: "", expires: 0 },
    AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  );
  return { access: creds.access, refresh: creds.refresh, expires: creds.expires };
}

let refreshing = false;
let lastAttempt = 0;

export async function refreshNow(reason: string, force = false): Promise<boolean> {
  if (refreshing) return false;
  if (!force && Date.now() - lastAttempt < MIN_ATTEMPT_GAP_MS) return false;
  const { refresh } = currentCreds();
  if (!refresh) {
    log.error("no anthropic refresh token available; reseed required (auth.md)", undefined, { reason });
    return false;
  }
  refreshing = true;
  lastAttempt = Date.now();
  try {
    const creds = await refreshCreds(refresh);
    setLiveCreds(creds);
    log.info("anthropic token refreshed", {
      reason,
      expiresIso: new Date(creds.expires).toISOString(),
      rotatedRefresh: creds.refresh !== refresh,
    });
    try {
      await patchTokenSecret(creds);
    } catch (e) {
      log.error("token secret patch failed; a restart before the next refresh needs a reseed", e, {
        secret: secretName(),
        namespace: ns(),
      });
    }
    return true;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (/invalid_grant/i.test(err)) {
      clearLiveCreds();
      log.error("anthropic refresh token rejected (invalid_grant); reseed required (auth.md)", e, {
        reason,
      });
    } else {
      log.warn("anthropic token refresh failed", { reason, error: err });
    }
    return false;
  } finally {
    refreshing = false;
  }
}

const NO_CRED_LOG_GAP_MS = 60 * 60_000;
let lastNoCredLog = 0;

function warnNoCredential(): void {
  const now = Date.now();
  if (now - lastNoCredLog < NO_CRED_LOG_GAP_MS) return;
  lastNoCredLog = now;
  log.error(
    "no ANTHROPIC_REFRESH_TOKEN in the mounted secret; the access token will expire unrefreshed (auth.md)",
  );
}

export function startTokenRefresh(): void {
  const { refresh, expires } = currentCreds();
  if (!refresh && process.env.ANTHROPIC_API_KEY) {
    log.info("token refresh disabled: static ANTHROPIC_API_KEY");
    return;
  }
  if (!refresh) warnNoCredential();
  log.info("token refresh scheduled", {
    cron: TICK_CRON,
    expiresIso: expires ? new Date(expires).toISOString() : "unknown",
    armed: Boolean(refresh),
  });
  Bun.cron(TICK_CRON, async () => {
    const working = inflightCount() > 0;
    const plan = planTick(currentCreds(), Date.now(), working);
    if (plan === "no-credential") {
      warnNoCredential();
      return;
    }
    if (plan === "wait") return;
    if (plan === "defer") {
      log.info("token refresh deferred: work in flight", { inflight: inflightCount() });
      return;
    }
    await refreshNow(working ? "expiry-deadline" : "scheduled");
  });
}
