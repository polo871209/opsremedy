import { input, password } from "@inquirer/prompts";
import { DEFAULT_JAEGER_URL, type OpsremedyConfig } from "../../config.ts";

export async function sectionJaeger(
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
