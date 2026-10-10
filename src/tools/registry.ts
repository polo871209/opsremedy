import type { Diagnosis } from "../diagnosis.ts";
import type { Config } from "../config.ts";
import type { SreTool } from "./types.ts";
import { gcpLoggingTool } from "./gcp_logging.ts";
import { promTools } from "./prom.ts";
import { moversTool } from "./movers.ts";
import { kubernetesTools } from "./kubernetes.ts";
import { jaegerTools } from "./jaeger.ts";
import { kafkaTools } from "./kafka.ts";
import { withRetry } from "../utils/retry.ts";
import { withMaxOutput } from "../utils/cap.ts";
import { isUngrounded } from "./evidence.ts";
import { ungroundedClaims } from "./grounding.ts";

export const SUBMIT_DIAGNOSIS = "submit_diagnosis";

export const SUBMIT_DIAGNOSIS_DESCRIPTION =
  "Record the final root cause analysis and end the run. " +
  "Rejected if an evidence or remediation line writes a bare [label] with no (url), if an evidence line shares " +
  "no number, identifier, or error string with anything a tool returned, or if the tool output does not support the " +
  "root cause or a bullet. Rejection names the offending lines: fix those and call again.";

export type DiagnosisReview = { rejected: string; byGrounding: boolean } | undefined;

export async function reviewDiagnosis(
  d: Diagnosis,
  corpus: string,
  groundingRejected: boolean,
): Promise<DiagnosisReview> {
  const badLinks: string[] = [];
  const bareLink = /(^|[^\\])\[[^\]\n]+\](?!\()/;
  for (const [i, line] of d.evidence.entries()) {
    if (bareLink.test(line)) badLinks.push(`evidence[${i}]: ${line}`);
  }
  for (const [i, line] of (d.remediationSteps ?? []).entries()) {
    if (bareLink.test(line)) badLinks.push(`remediationSteps[${i}]: ${line}`);
  }
  if (badLinks.length) {
    return {
      byGrounding: false,
      rejected:
        `Rejected: bare [label] without (url). Supply the tool's deep link as [label](https://...), or drop the brackets ` +
        `and write plain text. Re-call submit_diagnosis with those lines fixed.\n\nOffending lines:\n` +
        badLinks.join("\n"),
    };
  }
  if (!corpus) return undefined;
  const ungrounded = d.evidence
    .map((line, i) => (isUngrounded(line, corpus) ? `evidence[${i}]: ${line}` : undefined))
    .filter((x): x is string => !!x);
  if (ungrounded.length) {
    return {
      byGrounding: false,
      rejected:
        `Rejected: these evidence bullets share no number, error string, or identifier with any tool result, ` +
        `so nothing in the investigation backs them. Cite what a tool actually returned, or drop the claim.\n\nOffending lines:\n` +
        ungrounded.join("\n"),
    };
  }
  if (groundingRejected) return undefined;
  const failed = await ungroundedClaims([d.rootCause, ...d.evidence], corpus);
  if (!failed.length) return undefined;
  const lines = failed.map((i) => (i === 0 ? `rootCause: ${d.rootCause}` : `evidence[${i - 1}]: ${d.evidence[i - 1]}`));
  return {
    byGrounding: true,
    rejected:
      `Rejected: the investigation transcript does not support these lines. Rewrite each one to state what a tool ` +
      `returned, drop the claim, or lower confidence and set rootCauseCategory=unknown. Then call submit_diagnosis again.` +
      `\n\nOffending lines:\n${lines.join("\n")}`,
  };
}

export function resolveTools(cfg: Config): SreTool[] {
  const tools: SreTool[] = [];
  if (cfg.gcp.project) tools.push(gcpLoggingTool(cfg.gcp.project));
  if (cfg.prometheus.url) {
    tools.push(...promTools(cfg.prometheus.url, cfg.grafana.url, cfg.prometheus.datasourceUid));
    tools.push(moversTool(cfg.prometheus.url));
  }
  if (cfg.jaeger?.addr) tools.push(...jaegerTools(cfg.jaeger.addr));
  if (cfg.kafka?.brokers?.length) tools.push(...kafkaTools(cfg.kafka.brokers));
  tools.push(...kubernetesTools(cfg.kubernetes.namespace));
  return tools.map((t) => withMaxOutput(t.retry ? withRetry(t) : t));
}
