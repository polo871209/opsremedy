import { input, password, select } from "@inquirer/prompts";
import { DEFAULT_PROM_URL, type OpsremedyConfig } from "../../config.ts";

export async function sectionProm(
  cfg: OpsremedyConfig,
  reachable: boolean,
): Promise<{
  fileShape: NonNullable<OpsremedyConfig["prom"]>;
  bearerToken: string | undefined;
  password: string | undefined;
}> {
  console.log("\n== Prometheus ==");

  const auth = await select<"none" | "bearer" | "basic" | "gcp">({
    message: "Auth",
    choices: [
      { name: "none", value: "none" },
      { name: "bearer token", value: "bearer" },
      { name: "basic auth", value: "basic" },
      {
        name: "Google Managed Prometheus (ADC, refreshes per request)",
        value: "gcp",
      },
    ],
    default: "none",
  });

  let url: string;
  if (auth === "gcp") {
    const projectHint = cfg.gcp?.project_id ?? "<PROJECT_ID>";
    const defaultUrl = cfg.prom?.url?.includes("monitoring.googleapis.com")
      ? cfg.prom.url
      : `https://monitoring.googleapis.com/v1/projects/${projectHint}/location/global/prometheus`;
    url = await input({
      message: "Prometheus URL (Google Managed Prometheus)",
      default: defaultUrl,
    });
  } else {
    url = await input({
      message: `Prometheus URL${reachable ? " (default reachable)" : ""}`,
      default: cfg.prom?.url ?? DEFAULT_PROM_URL,
    });
  }

  const fileShape: NonNullable<OpsremedyConfig["prom"]> = { url };
  let bearerToken: string | undefined;
  let pw: string | undefined;

  if (auth === "bearer") {
    fileShape.auth = "static";
    const t = await password({ message: "Bearer token", mask: "*" });
    bearerToken = t || undefined;
  } else if (auth === "basic") {
    fileShape.auth = "static";
    const user = await input({ message: "Basic-auth user", default: cfg.prom?.user ?? "" });
    if (user) fileShape.user = user;
    const t = await password({ message: "Basic-auth password", mask: "*" });
    pw = t || undefined;
  } else if (auth === "gcp") {
    fileShape.auth = "gcp";
  } else {
    fileShape.auth = "static";
  }

  return { fileShape, bearerToken, password: pw };
}
