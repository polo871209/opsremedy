import { diagnose } from "./diagnose.ts";
import { gatherEvidence } from "./gather.ts";
import type { Alert, InvestigationContext, RCAReport } from "./types.ts";
import { addUsage } from "./util/usage.ts";
import { validateAndFinalize } from "./validate.ts";

export interface RunOptions {
  provider?: string;
  model?: string;
  max_tool_calls?: number;
  onEvent?: (kind: string, detail?: unknown) => void;
}

export function newContext(alert: Alert, maxToolCalls = 20): InvestigationContext {
  return {
    alert,
    evidence: {},
    tools_called: [],
    loop_count: 0,
    max_tool_calls: maxToolCalls,
    started_at: Date.now(),
  };
}

export async function runInvestigation(alert: Alert, options: RunOptions = {}): Promise<RCAReport> {
  const provider = options.provider ?? Bun.env.OPSREMEDY_LLM_PROVIDER ?? "anthropic";
  const model = options.model ?? Bun.env.OPSREMEDY_LLM_MODEL ?? "claude-sonnet-4-5-20250929";
  const maxToolCalls = options.max_tool_calls ?? Number(Bun.env.OPSREMEDY_MAX_TOOL_CALLS ?? 20);

  const ctx = newContext(alert, maxToolCalls);
  options.onEvent?.("investigation_start", { alert_id: alert.alert_id });

  options.onEvent?.("gather_start");
  const gatherUsage = await gatherEvidence(ctx, { provider, model, onEvent: options.onEvent });
  options.onEvent?.("gather_usage", gatherUsage);

  options.onEvent?.("diagnose_start");
  const { report: rawReport, usage: diagnoseUsage } = await diagnose(ctx, { provider, model });
  options.onEvent?.("diagnose_usage", diagnoseUsage);

  options.onEvent?.("validate_start");
  const validated = validateAndFinalize(rawReport, ctx);
  const final: RCAReport = { ...validated, usage: addUsage(gatherUsage, diagnoseUsage) };

  options.onEvent?.("investigation_end", {
    category: final.root_cause_category,
    confidence: final.confidence,
    usage: final.usage,
  });
  return final;
}
