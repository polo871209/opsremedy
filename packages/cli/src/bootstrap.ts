import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import {
  RealGcpLoggingClient,
  RealJaegerClient,
  RealK8sClient,
  RealPromClient,
  setClients,
} from "@opsremedy/clients";
import {
  applyCredentialsToEnv,
  configPath,
  credentialsPath,
  loadConfig,
  loadCredentials,
  type OpsremedyCredentials,
  type ResolvedSettings,
  resolveSettings,
  saveCredentials,
} from "./config.ts";
import { discoverProviderEnvVar } from "./discover.ts";
import { ensureFreshOAuthToken } from "./oauth.ts";

export interface BootstrapResult {
  settings: ResolvedSettings;
}

/**
 * Auth-only bootstrap: register pi-ai providers, load config/credentials,
 * refresh OAuth, and push secrets into process.env. Does NOT wire data-source
 * clients. Bench uses this; investigate uses bootstrapRealClients which
 * additionally wires real GCP/Prom/Jaeger/K8s clients.
 */
export async function bootstrapAuth(): Promise<BootstrapResult> {
  registerBuiltInApiProviders();

  const cfg = loadConfig();
  let creds = loadCredentials();
  const settings = resolveSettings(cfg, creds);

  creds = await refreshOAuthTokens(creds, settings.llm.provider);

  // Make LLM keys (static and OAuth) visible to pi-ai's getEnvApiKey().
  // `findEnvKeys` only reports vars that are *already set*, so we use the
  // probe-set discovery helper to learn the canonical name for each provider
  // even when the user has only stored the key in credentials.yml.
  const envKeyMap = new Map<string, string[]>();
  for (const provider of Object.keys(creds.llm_keys ?? {})) {
    const names = discoverProviderEnvVar(provider);
    if (names.length > 0) envKeyMap.set(provider, names);
  }
  applyCredentialsToEnv(creds, envKeyMap);
  pushOAuthTokensToEnv(creds);

  return { settings };
}

/**
 * Load config + credentials, refresh OAuth tokens if needed, fail-fast on
 * missing required fields, push secrets into process.env so pi-ai's built-in
 * key resolution finds them, then wire the real clients into the registry.
 */
export async function bootstrapRealClients(): Promise<BootstrapResult> {
  const { settings } = await bootstrapAuth();

  // Optional ADC pointer.
  if (settings.gcp.credentialsPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = settings.gcp.credentialsPath;
  }

  const missing: string[] = [];
  if (!settings.gcp.projectId) missing.push("gcp.project_id (or GCP_PROJECT_ID)");
  if (!settings.prom.url) missing.push("prom.url (or PROM_URL)");
  if (!settings.jaeger.url) missing.push("jaeger.url (or JAEGER_URL)");
  if (missing.length > 0) {
    throw new Error(
      [
        `Missing configuration: ${missing.join(", ")}.`,
        `Run \`opsremedy onboard\` to set these interactively.`,
        `Config file: ${configPath()}`,
        `Credentials file: ${credentialsPath()}`,
      ].join("\n"),
    );
  }

  setClients({
    gcp: new RealGcpLoggingClient(settings.gcp.projectId as string),
    prom: new RealPromClient({
      baseUrl: settings.prom.url,
      ...(settings.prom.bearerToken && { bearerToken: settings.prom.bearerToken }),
      ...(settings.prom.basicAuth && { basicAuth: settings.prom.basicAuth }),
    }),
    jaeger: new RealJaegerClient({
      baseUrl: settings.jaeger.url,
      ...(settings.jaeger.token && { token: settings.jaeger.token }),
    }),
    k8s: new RealK8sClient({
      ...(settings.k8s.kubeconfigPath && { kubeconfigPath: settings.k8s.kubeconfigPath }),
      ...(settings.k8s.context && { context: settings.k8s.context }),
    }),
  });

  return { settings };
}

/**
 * For the active LLM provider, refresh OAuth credentials if they're near
 * expiry. Persists updated creds back to disk. Other providers' OAuth tokens
 * are left untouched.
 */
async function refreshOAuthTokens(
  creds: OpsremedyCredentials,
  activeProvider: string,
): Promise<OpsremedyCredentials> {
  const stored = creds.llm_oauth?.[activeProvider];
  if (!stored) return creds;

  try {
    const { creds: updated, refreshed } = await ensureFreshOAuthToken(activeProvider, stored);
    if (!refreshed) return creds;
    const next: OpsremedyCredentials = {
      ...creds,
      llm_oauth: { ...(creds.llm_oauth ?? {}), [activeProvider]: updated },
    };
    saveCredentials(next);
    return next;
  } catch (err) {
    throw new Error(
      `Failed to refresh OAuth token for ${activeProvider}: ${(err as Error).message}\n` +
        `Re-run \`opsremedy onboard\` to log in again.`,
    );
  }
}

/**
 * For each provider with stored OAuth credentials, expose the access token
 * via the appropriate env var so pi-ai's stream functions pick it up.
 */
function pushOAuthTokensToEnv(creds: OpsremedyCredentials): void {
  for (const [provider, oauth] of Object.entries(creds.llm_oauth ?? {})) {
    const envName = oauthEnvVarFor(provider);
    if (!envName) continue;
    if (!process.env[envName]) process.env[envName] = oauth.access;
  }
}

function oauthEnvVarFor(provider: string): string | undefined {
  // pi-ai conventions for OAuth-capable providers.
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_OAUTH_TOKEN";
    case "github-copilot":
      return "COPILOT_GITHUB_TOKEN";
    case "google-gemini-cli":
    case "google-antigravity":
      // pi-ai resolves these via auth file lookups; nothing to set here.
      return undefined;
    case "openai-codex":
      // Codex uses its own token store, not an env var.
      return undefined;
    default:
      return undefined;
  }
}
