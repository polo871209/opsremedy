import { select } from "@inquirer/prompts";
import type { OpsremedyConfig } from "../../config.ts";
import type { discoverGcp } from "../../discover.ts";

export async function sectionGcp(
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
