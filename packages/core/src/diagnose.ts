import { Agent } from "@mariozechner/pi-agent-core";
import { DIAGNOSE_SYSTEM_PROMPT, renderDiagnosisUserPrompt } from "./prompts.ts";
import type { InvestigationContext, RCAReport } from "./types.ts";
import { extractJsonObject, safeParse } from "./util/json.ts";
import { resolveModel } from "./util/model.ts";
import { sumUsage, type UsageTotal, ZERO_USAGE } from "./util/usage.ts";
import { coerceRCAReport } from "./validate.ts";

export interface DiagnoseOptions {
  provider: string;
  model: string;
}

export interface DiagnoseResult {
  report: RCAReport;
  usage: UsageTotal;
}

/**
 * Phase 2 — no tools, produce a single strict-JSON RCA report.
 * Retries once on parse failure with a correction prompt.
 */
export async function diagnose(ctx: InvestigationContext, options: DiagnoseOptions): Promise<DiagnoseResult> {
  const model = resolveModel(options.provider, options.model);

  const agent = new Agent({
    initialState: {
      systemPrompt: DIAGNOSE_SYSTEM_PROMPT,
      model,
      thinkingLevel: "medium",
      tools: [],
    },
  });

  await agent.prompt(renderDiagnosisUserPrompt(ctx));
  let report = parseFromAgent(agent, ctx.alert.alert_id);

  if (!report) {
    // One retry with a correction message.
    await agent.prompt(
      `Your previous response was not valid JSON matching the required schema. Respond with ONLY the JSON object, no markdown fences, no commentary.`,
    );
    report = parseFromAgent(agent, ctx.alert.alert_id);
  }

  const usage = sumUsage(agent.state.messages as never);

  if (!report) {
    // Last-resort fallback so the CLI always returns something.
    return {
      report: {
        alert_id: ctx.alert.alert_id,
        root_cause: "Diagnosis agent failed to produce valid JSON output after one retry.",
        root_cause_category: "unknown",
        confidence: 0,
        causal_chain: [],
        validated_claims: [],
        unverified_claims: ["Diagnosis output invalid"],
        remediation: [],
        tools_called: [],
        duration_ms: 0,
        usage: ZERO_USAGE,
      },
      usage,
    };
  }

  return { report, usage };
}

function parseFromAgent(agent: Agent, alertId: string): RCAReport | null {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = extractAssistantText(msg);
    if (!text) continue;
    const json = extractJsonObject(text);
    if (!json) continue;
    const parsed = safeParse<unknown>(json);
    if (!parsed) continue;
    const report = coerceRCAReport(parsed, alertId);
    if (report) return report;
  }
  return null;
}

function extractAssistantText(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
