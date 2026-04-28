import type { RCAReport } from "@opsremedy/core/types";
import type { LarkConfig, SendPolicy } from "../types.ts";

/**
 * Decide whether a finished investigation should produce a Lark message.
 * Pure function; CLI wires it to the resolved config and `--lark`/`--no-lark`
 * flags before calling sendLarkCard.
 */
export function shouldSend(report: RCAReport, policy: SendPolicy, cfg: LarkConfig): boolean {
  if (policy === "always") return true;
  if (report.root_cause_category === "healthy") return false;
  if (policy === "non_healthy") return true;
  // low_confidence: only when category is non-healthy AND confidence below cutoff.
  return report.confidence < cfg.lowConfidenceThreshold;
}
