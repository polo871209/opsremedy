import type { AgentChange } from "@earendil-works/pi-durable";
import type { Alert } from "./alert.ts";
import type { Config } from "./config.ts";
import type { Diagnosis } from "./diagnosis.ts";
import { submitAssessmentTool, submitDiagnosisTool } from "./harness/tools.ts";
import { buildModel } from "./model.ts";
import {
  assessPrompt,
  DIAGNOSIS_SYSTEM_PROMPT,
  formatAlertContext,
  MAINTAINER_BLOCK,
  systemPrompt,
  untrusted,
  VERDICT_SYSTEM_PROMPT,
} from "./prompt.ts";
import { buildSeedContext, loadSeedCalls, resolveSeedCalls } from "./source/seed.ts";
import { resolveTools } from "./tools/registry.ts";
import { log } from "./utils/logger.ts";
import { makeTimeWindow } from "./utils/timewindow.ts";

export interface InvestigationResult {
  diagnosis?: Diagnosis;
  turns: number;
  stopped: "diagnosis" | "error";
  error?: string;
  cost?: number;
}

export type AgentMode = "investigate" | "followup" | "diagnose" | "assess" | "verdict";

function modePrompt(cfg: Config, mode: AgentMode, maintainer = false): string {
  if (mode === "diagnose") return DIAGNOSIS_SYSTEM_PROMPT;
  if (mode === "verdict") return VERDICT_SYSTEM_PROMPT;
  if (mode === "assess") return assessPrompt(cfg);
  const base = systemPrompt(cfg);
  return maintainer ? `${base}\n\n${MAINTAINER_BLOCK}` : base;
}

function modelChoice(cfg: Config, modelId: string): Pick<AgentChange, "model" | "thinkingLevel"> {
  const model = buildModel(cfg, modelId);
  return {
    model: { provider: cfg.model.provider, modelId },
    thinkingLevel: model.reasoning ? (cfg.model.reasoning ?? "low") : "off",
  };
}

export function agentFor(cfg: Config, mode: AgentMode, maintainer = false): AgentChange {
  if (mode === "diagnose") {
    return {
      ...modelChoice(cfg, cfg.model.synthesis),
      tools: [submitDiagnosisTool],
      instructions: modePrompt(cfg, mode),
    };
  }
  if (mode === "verdict") {
    return {
      ...modelChoice(cfg, cfg.model.synthesis),
      tools: [submitAssessmentTool],
      instructions: modePrompt(cfg, mode),
    };
  }
  const modelId = mode === "followup" ? cfg.model.synthesis : cfg.model.investigation;
  return {
    ...modelChoice(cfg, modelId),
    tools: { remove: [submitDiagnosisTool, submitAssessmentTool] },
    instructions: modePrompt(cfg, mode, maintainer),
  };
}

export function budgetFor(cfg: Config, alert: Alert): number {
  const sev = (alert.severity ?? "").toLowerCase();
  return cfg.agent.turnsBySeverity?.[sev] ?? cfg.agent.maxTurns;
}

async function seedCallsBlock(alert: Alert, cfg: Config): Promise<string> {
  const tw = makeTimeWindow(alert);
  const window = { start: tw.startISO(), end: tw.endISO() };
  const seeds = [
    ...(alert.seedCalls ?? []),
    ...resolveSeedCalls(alert, loadSeedCalls(), buildSeedContext(alert, window, cfg.kubernetes.namespace)),
  ];
  if (!seeds.length) return "";
  const tools = resolveTools(cfg);
  let block = "";
  for (const seed of seeds) {
    const tool = tools.find((t) => t.name === seed.tool);
    if (!tool) continue;
    try {
      const result = await tool.execute(seed.args, tw);
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      block += `\n\n--- Already executed for you, do not repeat: ${seed.tool}(${JSON.stringify(seed.args)}) ---\n${untrusted("tool_output", text)}`;
    } catch (e) {
      log.warn("seed call failed", { tool: seed.tool, args: seed.args, error: String(e) });
    }
  }
  return block;
}

export async function buildInvestigationPrompt(alert: Alert, cfg: Config): Promise<string> {
  return formatAlertContext(alert) + (await seedCallsBlock(alert, cfg));
}
