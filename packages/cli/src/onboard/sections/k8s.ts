import { select } from "@inquirer/prompts";
import type { OpsremedyConfig } from "../../config.ts";
import { defaultKubeconfigPath, type discoverK8sContexts } from "../../discover.ts";

export async function sectionK8s(
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
