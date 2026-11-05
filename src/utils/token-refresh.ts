import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Models } from "@earendil-works/pi-ai";
import { CoreV1Api, KubeConfig, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import { log } from "./logger.ts";
import { SecretCredentialStore, type Creds } from "./anthropic_token.ts";

const TICK_CRON = "*/5 * * * *";
const REFRESH_TIMEOUT_MS = 30_000;
const NO_CRED_LOG_GAP_MS = 60 * 60_000;

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

export const anthropicCredentials = new SecretCredentialStore(patchTokenSecret);

let lastNoCredLog = 0;

function warnNoCredential(): void {
  const now = Date.now();
  if (now - lastNoCredLog < NO_CRED_LOG_GAP_MS) return;
  lastNoCredLog = now;
  log.error(
    "no ANTHROPIC_REFRESH_TOKEN in the mounted secret; the access token will expire unrefreshed (auth.md)",
  );
}

export async function startTokenRefresh(
  models: Pick<Models, "getAuth">,
  credentials: Pick<SecretCredentialStore, "read"> = anthropicCredentials,
): Promise<void> {
  const armed = Boolean(await credentials.read("anthropic"));
  if (!armed && process.env.ANTHROPIC_API_KEY) {
    log.info("token refresh disabled: static ANTHROPIC_API_KEY");
    return;
  }
  if (!armed) warnNoCredential();
  log.info("token refresh scheduled", { cron: TICK_CRON, armed });
  Bun.cron(TICK_CRON, async () => {
    if (!(await credentials.read("anthropic"))) {
      warnNoCredential();
      return;
    }
    try {
      await models.getAuth("anthropic");
    } catch (e) {
      log.warn("anthropic token refresh failed", { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
