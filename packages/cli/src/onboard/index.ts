import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import {
  DEFAULT_JAEGER_URL,
  DEFAULT_PROM_URL,
  loadConfig,
  loadCredentials,
  type OpsremedyConfig,
  type OpsremedyCredentials,
  saveConfig,
  saveCredentials,
} from "../config.ts";
import { discoverGcp, discoverK8sContexts, probeJaegerUrl, probePromUrl } from "../discover.ts";
import { sectionAgent } from "./sections/agent.ts";
import { sectionGcp } from "./sections/gcp.ts";
import { sectionJaeger } from "./sections/jaeger.ts";
import { sectionK8s } from "./sections/k8s.ts";
import { sectionLlm } from "./sections/llm.ts";
import { sectionProm } from "./sections/prom.ts";

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
