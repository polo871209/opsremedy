import { diagnose } from "./diagnose.ts";
import { gatherEvidence } from "./gather.ts";
import type { InvestigationContext, RCAReport } from "./types.ts";
import { addUsage } from "./util/usage.ts";
import { validateAndFinalize } from "./validate.ts";

/**
 * Common options for the gather → diagnose → validate pipeline. Shared by
 * the CLI's `runInvestigation` (top-level entry point) and the bench
 * runner (which needs the populated context for scoring).
 */
export interface PipelineOptions {
  provider: string;
  model: string;
  /** Render LLM thinking on stderr. Default true. */
  displayThinking?: boolean;
  /** Progress + tracing callback. */
  onEvent?: (kind: string, detail?: unknown) => void;
}

/**
 * Run all three phases against a pre-built context. The context is mutated
 * in-place during gather (evidence + tool audit), so callers retain access
 * to it after this returns.
 */
export async function executePipeline(
  ctx: InvestigationContext,
  options: PipelineOptions,
): Promise<RCAReport> {
  const { onEvent, displayThinking = true, provider, model } = options;

  onEvent?.("gather_start");
  const gatherUsage = await gatherEvidence(ctx, {
    provider,
    model,
    displayThinking,
    ...(onEvent && { onEvent }),
  });
  onEvent?.("gather_usage", gatherUsage);

  onEvent?.("diagnose_start");
  const { report: rawReport, usage: diagnoseUsage } = await diagnose(ctx, {
    provider,
    model,
    displayThinking,
    ...(onEvent && { onEvent }),
  });
  onEvent?.("diagnose_usage", diagnoseUsage);

  onEvent?.("validate_start");
  const validated = validateAndFinalize(rawReport, ctx);
  return { ...validated, usage: addUsage(gatherUsage, diagnoseUsage) };
}
