import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { findEnvKeys, getModels, getProviders } from "@mariozechner/pi-ai";
import {
  DEFAULT_JAEGER_URL,
  DEFAULT_KUBECONFIG,
  DEFAULT_PROM_URL,
  loadConfig,
  loadCredentials,
  type OpsremedyConfig,
  type OpsremedyCredentials,
  saveConfig,
  saveCredentials,
} from "./config.ts";

/**
 * Interactive wizard that records LLM provider/model + datasource URLs into
 * config.yml and any required API keys into credentials.yml. Existing values
 * are presented as defaults so re-running just confirms.
 */
export async function runOnboard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("opsremedy onboard\n");
    const existing = loadConfig();
    const existingCreds = loadCredentials();

    const llm = await pickLlm(rl, existing, existingCreds);
    const gcp = await pickGcp(rl, existing);
    const prom = await pickProm(rl, existing);
    const jaeger = await pickJaeger(rl, existing);
    const k8s = await pickK8s(rl, existing);
    const agent = await pickAgent(rl, existing);

    const newConfig: OpsremedyConfig = {
      llm: { provider: llm.provider, model: llm.modelId },
      ...(Object.keys(gcp).length > 0 && { gcp }),
      prom: prom.fileShape,
      jaeger: { url: jaeger.url },
      ...(k8s.kubeconfig && { k8s: { kubeconfig: k8s.kubeconfig } }),
      agent,
    };
    const cfgFile = saveConfig(newConfig);
    console.log(`\nWrote config: ${cfgFile}`);

    const newCreds: OpsremedyCredentials = {
      ...existingCreds,
      ...(llm.apiKey && {
        llm_keys: { ...(existingCreds.llm_keys ?? {}), [llm.provider]: llm.apiKey },
      }),
      ...(prom.bearerToken !== undefined && { prom_bearer_token: prom.bearerToken }),
      ...(prom.password !== undefined && { prom_password: prom.password }),
      ...(jaeger.token !== undefined && { jaeger_token: jaeger.token }),
    };
    if (Object.keys(newCreds).length > 0) {
      const credsFile = saveCredentials(newCreds);
      console.log(`Wrote credentials (chmod 600): ${credsFile}`);
    }

    console.log("\nDone. Try: opsremedy investigate -i alert.json");
  } finally {
    rl.close();
  }
}

// ---------------- sections ----------------

async function pickLlm(
  rl: Interface,
  cfg: OpsremedyConfig,
  creds: OpsremedyCredentials,
): Promise<{ provider: string; modelId: string; apiKey: string | undefined }> {
  console.log("== LLM ==");
  const providers = getProviders();
  const defaultProvider =
    cfg.llm?.provider && providers.includes(cfg.llm.provider as never) ? cfg.llm.provider : "anthropic";

  const provider = await pickFromList(rl, "Provider", providers, defaultProvider);

  const models = getModels(provider as never);
  if (models.length === 0) {
    throw new Error(`Provider ${provider} has no models registered.`);
  }
  const modelIds = models.map((m) => m.id);
  const defaultModel = cfg.llm?.model && modelIds.includes(cfg.llm.model) ? cfg.llm.model : modelIds[0]!;
  const modelId = await pickFromList(rl, "Model", modelIds, defaultModel);

  // Key handling — pick the first env var name pi-ai recognizes for this provider.
  const envNames = findEnvKeys(provider) ?? [];
  let apiKey: string | undefined;
  if (envNames.length > 0) {
    const existing = creds.llm_keys?.[provider] ?? envNames.map((n) => process.env[n]).find(Boolean);
    const masked = existing ? maskKey(existing) : "(none)";
    const promptText = `API key for ${provider} [${envNames[0]}] (current: ${masked}, blank to keep): `;
    const entered = await ask(rl, promptText, "");
    apiKey = entered ? entered : existing;
  } else {
    console.log(`(${provider} uses ambient credentials — no API key prompt)`);
  }

  return { provider, modelId, apiKey };
}

async function pickGcp(rl: Interface, cfg: OpsremedyConfig): Promise<NonNullable<OpsremedyConfig["gcp"]>> {
  console.log("\n== GCP Cloud Logging ==");
  const projectId = await ask(rl, "GCP project ID (blank to skip)", cfg.gcp?.project_id ?? "");
  const credsPath = await ask(
    rl,
    "GOOGLE_APPLICATION_CREDENTIALS path (blank for ADC)",
    cfg.gcp?.credentials_path ?? "",
  );
  const out: NonNullable<OpsremedyConfig["gcp"]> = {};
  if (projectId) out.project_id = projectId;
  if (credsPath) out.credentials_path = credsPath;
  return out;
}

async function pickProm(
  rl: Interface,
  cfg: OpsremedyConfig,
): Promise<{
  fileShape: NonNullable<OpsremedyConfig["prom"]>;
  bearerToken: string | undefined;
  password: string | undefined;
}> {
  console.log("\n== Prometheus ==");
  const url = await ask(rl, "Prometheus URL", cfg.prom?.url ?? DEFAULT_PROM_URL);
  const auth = await pickFromList(rl, "Auth", ["none", "bearer", "basic"], "none");

  const fileShape: NonNullable<OpsremedyConfig["prom"]> = { url };
  let bearerToken: string | undefined;
  let password: string | undefined;

  if (auth === "bearer") {
    bearerToken = (await ask(rl, "Bearer token", "")) || undefined;
  } else if (auth === "basic") {
    const user = await ask(rl, "Basic-auth user", cfg.prom?.user ?? "");
    if (user) fileShape.user = user;
    password = (await ask(rl, "Basic-auth password", "")) || undefined;
  }

  return { fileShape, bearerToken, password };
}

async function pickJaeger(
  rl: Interface,
  cfg: OpsremedyConfig,
): Promise<{ url: string; token: string | undefined }> {
  console.log("\n== Jaeger ==");
  const url = await ask(rl, "Jaeger URL", cfg.jaeger?.url ?? DEFAULT_JAEGER_URL);
  const tokenInput = await ask(rl, "Bearer token (blank for none)", "");
  return { url, token: tokenInput || undefined };
}

async function pickK8s(rl: Interface, cfg: OpsremedyConfig): Promise<{ kubeconfig: string | undefined }> {
  console.log("\n== Kubernetes ==");
  const kc = await ask(
    rl,
    "Kubeconfig path (blank for default loaders)",
    cfg.k8s?.kubeconfig ?? DEFAULT_KUBECONFIG,
  );
  if (kc && !existsSync(kc)) {
    console.log(`  warning: ${kc} does not exist (will fail at first k8s tool call)`);
  }
  return { kubeconfig: kc || undefined };
}

async function pickAgent(
  rl: Interface,
  cfg: OpsremedyConfig,
): Promise<NonNullable<OpsremedyConfig["agent"]>> {
  console.log("\n== Agent ==");
  const raw = await ask(rl, "Max tool calls per investigation", String(cfg.agent?.max_tool_calls ?? 20));
  const n = Number(raw);
  return { max_tool_calls: Number.isFinite(n) && n > 0 ? n : 20 };
}

// ---------------- prompt helpers ----------------

async function ask(rl: Interface, label: string, defaultValue: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function pickFromList(
  rl: Interface,
  label: string,
  options: string[],
  defaultValue: string,
): Promise<string> {
  console.log(`\n${label}:`);
  const indexed = options.map((opt, i) => `  ${i + 1}. ${opt}${opt === defaultValue ? " (default)" : ""}`);
  console.log(indexed.join("\n"));
  const answer = (await rl.question(`Choose 1-${options.length} or name [${defaultValue}]: `)).trim();
  if (!answer) return defaultValue;
  const asNumber = Number(answer);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1] as string;
  }
  if (options.includes(answer)) return answer;
  console.log(`  invalid choice, keeping default: ${defaultValue}`);
  return defaultValue;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
