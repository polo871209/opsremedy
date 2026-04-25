import { findEnvKeys } from "@mariozechner/pi-ai";
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
  type ResolvedSettings,
  resolveSettings,
} from "./config.ts";

export interface BootstrapResult {
  settings: ResolvedSettings;
}

/**
 * Load config + credentials, fail-fast if required fields are missing,
 * push secrets into process.env so pi-ai picks them up, then wire real clients.
 */
export function bootstrapRealClients(): BootstrapResult {
  const cfg = loadConfig();
  const creds = loadCredentials();
  const settings = resolveSettings(cfg, creds);

  // Make LLM keys visible to pi-ai's getEnvApiKey().
  const envKeyMap = new Map<string, string[]>();
  for (const provider of Object.keys(creds.llm_keys ?? {})) {
    const names = findEnvKeys(provider);
    if (names && names.length > 0) envKeyMap.set(provider, names);
  }
  applyCredentialsToEnv(creds, envKeyMap);

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
    }),
  });

  return { settings };
}
