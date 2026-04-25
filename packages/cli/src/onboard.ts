import { input, password, search, select } from "@inquirer/prompts";
import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { listModels, listProviders } from "@opsremedy/core";
import {
  DEFAULT_JAEGER_URL,
  DEFAULT_PROM_URL,
  loadConfig,
  loadCredentials,
  type OAuthCredentialRecord,
  type OpsremedyConfig,
  type OpsremedyCredentials,
  saveConfig,
  saveCredentials,
} from "./config.ts";
import {
  defaultKubeconfigPath,
  discoverGcp,
  discoverK8sContexts,
  discoverProviderEnvVar,
  probeJaegerUrl,
  probePromUrl,
} from "./discover.ts";
import { isOAuthProvider, runOAuthLogin } from "./oauth.ts";

/**
 * Interactive wizard. Auto-discovers gcloud projects, kubeconfig contexts,
 * Prom/Jaeger reachability. Saves config (URLs, model, etc.) to
 * $XDG_CONFIG_HOME and secrets (API keys) to $XDG_DATA_HOME with chmod 600.
 */
export async function runOnboard(): Promise<void> {
  registerBuiltInApiProviders();

  console.log("opsremedy onboard");
  console.log("Auto-discovering local tools...\n");

  const [gcp] = await Promise.all([discoverGcp()]);
  const k8sContexts = discoverK8sContexts();
  const promReachable = await probePromUrl(DEFAULT_PROM_URL);
  const jaegerReachable = await probeJaegerUrl(DEFAULT_JAEGER_URL);

  printDiscoverySummary({ gcp, k8sContexts, promReachable, jaegerReachable });

  const existing = loadConfig();
  const existingCreds = loadCredentials();

  const llm = await sectionLlm(existing, existingCreds);
  const gcpAnswers = await sectionGcp(existing, gcp);
  const promAnswers = await sectionProm(existing, promReachable);
  const jaegerAnswers = await sectionJaeger(existing, jaegerReachable);
  const k8sAnswers = await sectionK8s(existing, k8sContexts);
  const agentAnswers = await sectionAgent(existing);

  const newConfig: OpsremedyConfig = {
    llm: { provider: llm.provider, model: llm.modelId },
    ...(Object.keys(gcpAnswers).length > 0 && { gcp: gcpAnswers }),
    prom: promAnswers.fileShape,
    jaeger: { url: jaegerAnswers.url },
    k8s: { ...(k8sAnswers.context && { context: k8sAnswers.context }) },
    agent: agentAnswers,
  };
  // Drop empty k8s block.
  if (newConfig.k8s && Object.keys(newConfig.k8s).length === 0) delete newConfig.k8s;

  const cfgFile = saveConfig(newConfig);
  console.log(`\nWrote config: ${cfgFile}`);

  const newCreds: OpsremedyCredentials = {
    ...existingCreds,
    ...(llm.apiKey && {
      llm_keys: { ...(existingCreds.llm_keys ?? {}), [llm.provider]: llm.apiKey },
    }),
    ...(llm.oauth && {
      llm_oauth: { ...(existingCreds.llm_oauth ?? {}), [llm.provider]: llm.oauth },
    }),
    ...(promAnswers.bearerToken !== undefined && { prom_bearer_token: promAnswers.bearerToken }),
    ...(promAnswers.password !== undefined && { prom_password: promAnswers.password }),
    ...(jaegerAnswers.token !== undefined && { jaeger_token: jaegerAnswers.token }),
  };
  if (Object.keys(newCreds).length > 0) {
    const credsFile = saveCredentials(newCreds);
    console.log(`Wrote credentials (chmod 600): ${credsFile}`);
  }

  console.log("\nDone. Try: opsremedy investigate -i alert.json");
}

// ---------------- summary ----------------

function printDiscoverySummary(d: {
  gcp: Awaited<ReturnType<typeof discoverGcp>>;
  k8sContexts: ReturnType<typeof discoverK8sContexts>;
  promReachable: boolean;
  jaegerReachable: boolean;
}): void {
  const lines: string[] = [];
  lines.push(
    `  gcloud      : ${d.gcp.gcloudInstalled ? "found" : "not installed"}` +
      (d.gcp.gcloudInstalled
        ? ` (${d.gcp.projects.length} projects, active=${d.gcp.activeProject ?? "-"})`
        : ""),
  );
  lines.push(`  GCP ADC     : ${d.gcp.adcAvailable ? "yes" : "no"}`);
  lines.push(
    `  kubeconfig  : ${d.k8sContexts.length} context(s)` +
      (d.k8sContexts.length > 0 ? ` (current=${d.k8sContexts.find((c) => c.isCurrent)?.name ?? "-"})` : ""),
  );
  lines.push(
    `  prometheus  : ${d.promReachable ? `reachable @ ${DEFAULT_PROM_URL}` : "not reachable on default"}`,
  );
  lines.push(
    `  jaeger      : ${d.jaegerReachable ? `reachable @ ${DEFAULT_JAEGER_URL}` : "not reachable on default"}`,
  );
  console.log(lines.join("\n"));
  console.log("");
}

// ---------------- LLM ----------------

interface LlmAnswers {
  provider: string;
  modelId: string;
  apiKey: string | undefined;
  oauth: OAuthCredentialRecord | undefined;
}

async function sectionLlm(cfg: OpsremedyConfig, creds: OpsremedyCredentials): Promise<LlmAnswers> {
  console.log("== LLM ==");
  const providers = listProviders();
  const defaultProvider = providers.includes(cfg.llm?.provider as (typeof providers)[number])
    ? (cfg.llm?.provider as string)
    : "anthropic";

  const provider = await select<string>({
    message: "Provider",
    choices: providers.map((p) => ({ name: p, value: p })),
    default: defaultProvider,
  });

  const models = listModels(provider);
  if (models.length === 0) throw new Error(`Provider ${provider} has no models registered.`);
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(cfg.llm?.model ?? "")
    ? (cfg.llm?.model as string)
    : preferredModelFor(provider, modelIds);

  let modelId: string;
  if (modelIds.length > 12) {
    modelId = await search<string>({
      message: `Model (type to filter, ${modelIds.length} total)`,
      source: async (term) => {
        const t = (term ?? "").toLowerCase();
        const matches = modelIds.filter((id) => id.toLowerCase().includes(t));
        return matches.map((id) => ({ name: id === defaultModel ? `${id} (recommended)` : id, value: id }));
      },
    });
  } else {
    modelId = await select<string>({
      message: "Model",
      choices: modelIds.map((id) => ({ name: id, value: id })),
      default: defaultModel,
    });
  }

  const auth = await pickAuth(provider, creds);
  return { provider, modelId, apiKey: auth.apiKey, oauth: auth.oauth };
}

interface AuthAnswer {
  apiKey: string | undefined;
  oauth: OAuthCredentialRecord | undefined;
}

async function pickAuth(provider: string, creds: OpsremedyCredentials): Promise<AuthAnswer> {
  const envNames = discoverProviderEnvVar(provider);
  const supportsOAuth = isOAuthProvider(provider);
  const existingKey = creds.llm_keys?.[provider];
  const existingOAuth = creds.llm_oauth?.[provider];

  // Provider has neither OAuth nor static key (e.g. amazon-bedrock, google-vertex).
  if (!supportsOAuth && envNames.length === 0) {
    console.log(`  (${provider} uses ambient credentials — no key/OAuth prompt)`);
    return { apiKey: undefined, oauth: undefined };
  }

  // Build auth-method choices.
  const choices: Array<{ name: string; value: "oauth" | "key" | "keep" | "skip" }> = [];
  if (supportsOAuth) {
    choices.push({
      name: existingOAuth
        ? `Subscription / OAuth (currently linked, expires ${formatExpiry(existingOAuth.expires)})`
        : "Subscription / OAuth (e.g. Claude Pro/Max, ChatGPT Plus)",
      value: "oauth",
    });
  }
  if (envNames.length > 0) {
    choices.push({
      name: existingKey ? `API key (current: ${maskKey(existingKey)})` : `API key (${envNames.join(" or ")})`,
      value: "key",
    });
  }
  if (existingKey || existingOAuth) {
    choices.push({ name: "Keep existing credentials", value: "keep" });
  }
  choices.push({ name: "Skip (set credentials later)", value: "skip" });

  const choice = await select<"oauth" | "key" | "keep" | "skip">({
    message: "Authentication",
    choices,
    default: existingOAuth ? "oauth" : existingKey ? "key" : choices[0]?.value,
  });

  if (choice === "keep") {
    return { apiKey: undefined, oauth: undefined };
  }
  if (choice === "skip") {
    console.log("  (no credential saved — investigations will fail until you set one)");
    return { apiKey: undefined, oauth: undefined };
  }
  if (choice === "oauth") {
    console.log(`\nStarting ${provider} OAuth login...`);
    const tokens = await runOAuthLogin(provider);
    console.log(`  ✓ Linked. Refresh handled automatically.`);
    return { apiKey: undefined, oauth: tokens };
  }
  const entered = await password({
    message: `API key for ${provider} (env: ${envNames.join(" or ")}${existingKey ? `, blank to keep ${maskKey(existingKey)}` : ""})`,
    mask: "*",
    validate: (v) => v.length === 0 || v.length >= 10 || "key looks too short",
  });
  return {
    apiKey: entered || existingKey,
    oauth: undefined,
  };
}

function formatExpiry(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function preferredModelFor(provider: string, modelIds: string[]): string {
  // Soft preference: pick a sonnet/4-5 if anthropic, gpt-4o or gpt-5 if openai, else first.
  const preferences: Record<string, RegExp[]> = {
    anthropic: [/claude-sonnet-4-5-202\d{5}/, /claude-sonnet-4-5/, /claude-sonnet/],
    openai: [/^gpt-5/, /^gpt-4o/, /^gpt-4/],
    google: [/^gemini-2/, /^gemini-1\.5/],
  };
  const list = preferences[provider] ?? [];
  for (const re of list) {
    const hit = modelIds.find((id) => re.test(id));
    if (hit) return hit;
  }
  return modelIds[0] ?? "";
}

// ---------------- GCP ----------------

async function sectionGcp(
  cfg: OpsremedyConfig,
  gcp: Awaited<ReturnType<typeof discoverGcp>>,
): Promise<NonNullable<OpsremedyConfig["gcp"]>> {
  console.log("\n== GCP Cloud Logging ==");

  if (!gcp.gcloudInstalled) {
    console.log("  gcloud CLI not found.");
    console.log("  Install: https://cloud.google.com/sdk/docs/install");
    console.log("  Then: gcloud auth application-default login");
    console.log("  Skipping GCP — opsremedy will fail on GCP tool calls until configured.\n");
    return {};
  }

  if (!gcp.adcAvailable) {
    console.log("  Application Default Credentials not found.");
    console.log("  Run: gcloud auth application-default login");
    console.log("  (continuing — you can re-run onboard after authing)\n");
  }

  const projectChoices = gcp.projects.map((p) => ({
    name: p.projectId === gcp.activeProject ? `${p.projectId}  (active)` : `${p.projectId}  ${p.name}`,
    value: p.projectId,
    description: p.projectNumber ? `project number ${p.projectNumber}` : undefined,
  }));
  projectChoices.push({ name: "(skip GCP)", value: "", description: "Disable GCP integration" });

  const defaultProject =
    cfg.gcp?.project_id && gcp.projects.some((p) => p.projectId === cfg.gcp?.project_id)
      ? cfg.gcp.project_id
      : (gcp.activeProject ?? gcp.projects[0]?.projectId ?? "");

  const projectId = await select<string>({
    message: "GCP project",
    choices: projectChoices,
    default: defaultProject,
  });

  if (!projectId) return {};
  return { project_id: projectId };
}

// ---------------- Prometheus ----------------

async function sectionProm(
  cfg: OpsremedyConfig,
  reachable: boolean,
): Promise<{
  fileShape: NonNullable<OpsremedyConfig["prom"]>;
  bearerToken: string | undefined;
  password: string | undefined;
}> {
  console.log("\n== Prometheus ==");
  const url = await input({
    message: `Prometheus URL${reachable ? " (default reachable)" : ""}`,
    default: cfg.prom?.url ?? DEFAULT_PROM_URL,
  });

  const auth = await select<"none" | "bearer" | "basic">({
    message: "Auth",
    choices: [
      { name: "none", value: "none" },
      { name: "bearer token", value: "bearer" },
      { name: "basic auth", value: "basic" },
    ],
    default: "none",
  });

  const fileShape: NonNullable<OpsremedyConfig["prom"]> = { url };
  let bearerToken: string | undefined;
  let pw: string | undefined;

  if (auth === "bearer") {
    const t = await password({ message: "Bearer token", mask: "*" });
    bearerToken = t || undefined;
  } else if (auth === "basic") {
    const user = await input({ message: "Basic-auth user", default: cfg.prom?.user ?? "" });
    if (user) fileShape.user = user;
    const t = await password({ message: "Basic-auth password", mask: "*" });
    pw = t || undefined;
  }

  return { fileShape, bearerToken, password: pw };
}

// ---------------- Jaeger ----------------

async function sectionJaeger(
  cfg: OpsremedyConfig,
  reachable: boolean,
): Promise<{ url: string; token: string | undefined }> {
  console.log("\n== Jaeger ==");
  const url = await input({
    message: `Jaeger URL${reachable ? " (default reachable)" : ""}`,
    default: cfg.jaeger?.url ?? DEFAULT_JAEGER_URL,
  });
  const t = await password({
    message: "Bearer token (blank for none)",
    mask: "*",
    validate: () => true,
  });
  return { url, token: t || undefined };
}

// ---------------- Kubernetes ----------------

async function sectionK8s(
  cfg: OpsremedyConfig,
  contexts: ReturnType<typeof discoverK8sContexts>,
): Promise<{ context: string | undefined }> {
  console.log(`\n== Kubernetes (${defaultKubeconfigPath()}) ==`);
  if (contexts.length === 0) {
    console.log("  No contexts in default kubeconfig — install/configure kubectl, then re-run onboard.");
    return { context: undefined };
  }

  const choices = contexts.map((c) => ({
    name: c.isCurrent ? `${c.name}  (current)` : c.name,
    value: c.name,
    description: c.cluster ? `cluster=${c.cluster}${c.namespace ? `, ns=${c.namespace}` : ""}` : undefined,
  }));
  const defaultCtx =
    cfg.k8s?.context && contexts.some((c) => c.name === cfg.k8s?.context)
      ? cfg.k8s.context
      : (contexts.find((c) => c.isCurrent)?.name ?? contexts[0]?.name ?? "");

  const context = await select<string>({
    message: "Context",
    choices,
    default: defaultCtx,
  });
  return { context };
}

// ---------------- Agent ----------------

async function sectionAgent(cfg: OpsremedyConfig): Promise<NonNullable<OpsremedyConfig["agent"]>> {
  console.log("\n== Agent ==");
  const raw = await input({
    message: "Max tool calls per investigation",
    default: String(cfg.agent?.max_tool_calls ?? 20),
    validate: (v) => /^\d+$/.test(v) && Number(v) > 0,
  });
  return { max_tool_calls: Number(raw) };
}

// ---------------- helpers ----------------

function maskKey(key: string): string {
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
