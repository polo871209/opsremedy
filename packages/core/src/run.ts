import { executePipeline } from "./pipeline.ts";
import type { Alert, InvestigationContext, RCAReport } from "./types.ts";

export interface RunOptions {
  provider?: string;
  model?: string;
  max_tool_calls?: number;
  onEvent?: (kind: string, detail?: unknown) => void;
  /** Render LLM thinking on stderr. Default true. */
  displayThinking?: boolean;
}

export function newContext(alert: Alert, maxToolCalls = 20): InvestigationContext {
  return {
    alert,
    evidence: {},
    tools_called: [],
    loop_count: 0,
    inflight: 0,
    max_tool_calls: maxToolCalls,
    started_at: Date.now(),
    loop: 0,
    audit: [],
  };
}

/**
 * End-to-end entry point used by the CLI. Constructs a context, runs the
 * gather→diagnose→validate pipeline, and reports lifecycle events.
 *
 * Bench reuses `executePipeline` directly so it can keep the populated
 * context for scenario scoring.
 */
export async function runInvestigation(alert: Alert, options: RunOptions = {}): Promise<RCAReport> {
  const provider = options.provider ?? Bun.env.OPSREMEDY_LLM_PROVIDER ?? "anthropic";
  const model = options.model ?? Bun.env.OPSREMEDY_LLM_MODEL ?? "claude-sonnet-4-5-20250929";
  const maxToolCalls = options.max_tool_calls ?? Number(Bun.env.OPSREMEDY_MAX_TOOL_CALLS ?? 20);

  const ctx = newContext(alert, maxToolCalls);
  options.onEvent?.("investigation_start", { alert_id: alert.alert_id });

  const final = await executePipeline(ctx, {
    provider,
    model,
    displayThinking: options.displayThinking ?? true,
    ...(options.onEvent && { onEvent: options.onEvent }),
  });

  options.onEvent?.("investigation_end", {
    category: final.root_cause_category,
    confidence: final.confidence,
    usage: final.usage,
  });
  return final;
}
