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
