import { diagnose } from "./diagnose.ts";
import { emitInvestigationEvent, type InvestigationEventSink } from "./events.ts";
import { gatherEvidence } from "./gather.ts";
import { buildHealthyReport, isClearlyHealthy } from "./health/short-circuit.ts";
import { buildEvidenceProvenance } from "./provenance.ts";
import { buildRerouteHint, MAX_GATHER_LOOPS, shouldReroute } from "./reroute.ts";
import type { InvestigationContext, RCAReport } from "./types.ts";
import { addUsage, type UsageTotal, ZERO_USAGE } from "./util/usage.ts";
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
  onEvent?: InvestigationEventSink;
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
  const shortCircuitEnabled = Bun.env.OPSREMEDY_HEALTHY_SHORT_CIRCUIT !== "false";

  let gatherUsage: UsageTotal = { ...ZERO_USAGE };
  let rerouteHint: string | undefined;
  let lastReport: RCAReport | undefined;
  let lastDiagnoseUsage: UsageTotal = { ...ZERO_USAGE };

  for (let loop = 0; loop < MAX_GATHER_LOOPS; loop++) {
    ctx.loop = loop;
    onEvent?.("gather_start", { loop });
    emitInvestigationEvent(onEvent, "evidence_gather_started", { loop });
    const usage = await gatherEvidence(ctx, {
      provider,
      model,
      displayThinking,
      ...(onEvent && { onEvent }),
      ...(rerouteHint && { rerouteHint }),
    });
    gatherUsage = addUsage(gatherUsage, usage);
    onEvent?.("gather_usage", { loop, usage });

    // A1 — healthy short-circuit fires after each gather pass. Cheap exit
    // before paying for diagnose; works on either loop.
    if (shortCircuitEnabled) {
      const verdict = isClearlyHealthy(ctx.alert, ctx.evidence);
      if (verdict.healthy) {
        onEvent?.("healthy_short_circuit", { loop, reason: verdict.reason });
        const report = buildHealthyReport(ctx.alert, ctx.evidence, verdict.reason);
        return {
          ...report,
          tools_called: ctx.tools_called.map((t) => t.name),
          duration_ms: Date.now() - ctx.started_at,
          usage: addUsage(gatherUsage, lastDiagnoseUsage),
          ...(ctx.evidence.evidence_links && { evidence_links: ctx.evidence.evidence_links }),
          evidence_provenance: buildEvidenceProvenance(ctx),
        };
      }
    }

    onEvent?.("diagnose_start", { loop });
    emitInvestigationEvent(onEvent, "diagnosis_started", { loop });
    const { report: rawReport, usage: diagnoseUsage } = await diagnose(ctx, {
      provider,
      model,
      displayThinking,
      ...(onEvent && { onEvent }),
    });
    lastDiagnoseUsage = addUsage(lastDiagnoseUsage, diagnoseUsage);
    onEvent?.("diagnose_usage", { loop, usage: diagnoseUsage });

    onEvent?.("validate_start", { loop });
    lastReport = validateAndFinalize(rawReport, ctx);
    emitInvestigationEvent(onEvent, "validation_finished", {
      loop,
      category: lastReport.root_cause_category,
      confidence: lastReport.confidence,
    });

    // A3 — bounded reroute: one extra gather pass when first-pass diagnosis
    // is ambiguous and budget remains.
    const decision = shouldReroute(lastReport, ctx);
    if (!decision.reroute) {
      onEvent?.("reroute_skip", { loop, reason: decision.reason });
      break;
    }
    rerouteHint = buildRerouteHint(lastReport, ctx);
    onEvent?.("reroute", { loop, reason: decision.reason, hint: rerouteHint });
  }

  // lastReport is always set after at least one loop body completes; the
  // for-loop runs ≥1 iteration since MAX_GATHER_LOOPS>=1. The non-null
  // assertion encodes that invariant for the type system.
  const finalReport = lastReport!;
  return {
    ...finalReport,
    usage: addUsage(gatherUsage, lastDiagnoseUsage),
    ...(ctx.evidence.evidence_links && { evidence_links: ctx.evidence.evidence_links }),
  };
}
