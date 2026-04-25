import { input } from "@inquirer/prompts";
import type { OpsremedyConfig } from "../../config.ts";

export async function sectionAgent(cfg: OpsremedyConfig): Promise<NonNullable<OpsremedyConfig["agent"]>> {
  console.log("\n== Agent ==");
  const raw = await input({
    message: "Max tool calls per investigation",
    default: String(cfg.agent?.max_tool_calls ?? 20),
    validate: (v) => /^\d+$/.test(v) && Number(v) > 0,
  });
  return { max_tool_calls: Number(raw) };
}
