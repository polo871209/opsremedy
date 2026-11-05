import type { ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { AssessmentSchema, type Assessment } from "../assessment.ts";
import { DiagnosisSchema } from "../diagnosis.ts";
import { buildEvidenceCorpus, isUngrounded } from "../tools/evidence.ts";
import { reviewDiagnosis, SUBMIT_DIAGNOSIS, SUBMIT_DIAGNOSIS_DESCRIPTION } from "../tools/registry.ts";
import type { SreTool } from "../tools/types.ts";
import { log } from "../utils/logger.ts";
import { makeTimeWindow } from "../utils/timewindow.ts";
import { AlertDoc, alertOf, AssessmentDoc, json, ThreadDoc } from "./docs.ts";
import { allEntries, entriesSinceUser, messagesOf, roundsOf } from "./transcript.ts";

const MAX_STAGNANT_ROUNDS = 2;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

const callKey = (c: ToolCall) => `${c.name}:${stableStringify(c.arguments)}`;

type GateVerdict = { text: string; isError: boolean } | undefined;

function gate(
  rounds: readonly ToolCall[][],
  callId: string,
  budget: number | null,
  cheap: ReadonlySet<string>,
): GateVerdict {
  const seen = new Set<string>();
  let stagnant = 0;
  let expensive = 0;
  for (const round of rounds) {
    const at = round.findIndex((c) => c.id === callId);
    const calls = (at < 0 ? round : round.slice(0, at + 1)).filter((c) => c.name !== SUBMIT_DIAGNOSIS);
    if (at >= 0) {
      for (const c of calls.slice(0, -1)) seen.add(callKey(c));
      const call = round[at]!;
      if (stagnant >= MAX_STAGNANT_ROUNDS && call.name !== SUBMIT_DIAGNOSIS) {
        return {
          isError: true,
          text:
            `Tools revoked: the last ${MAX_STAGNANT_ROUNDS} turns only repeated calls you already made. ` +
            `Write your conclusion from the evidence gathered so far.`,
        };
      }
      if (budget !== null && !cheap.has(call.name) && expensive >= budget) {
        return {
          isError: true,
          text: `Tools revoked: turn budget exhausted (${budget}). Write your findings summary from the evidence gathered so far.`,
        };
      }
      if (seen.has(callKey(call))) {
        return {
          isError: false,
          text:
            `Not executed: ${call.name} already ran with these exact arguments. Its result is earlier in this ` +
            `conversation, so reuse it. Change the arguments to get different data, or continue your analysis.`,
        };
      }
      return undefined;
    }
    let duplicates = 0;
    let charged = false;
    for (const c of calls) {
      const key = callKey(c);
      if (seen.has(key)) duplicates++;
      else if (!cheap.has(c.name)) charged = true;
      seen.add(key);
    }
    if (calls.length > 0) stagnant = duplicates === calls.length ? stagnant + 1 : 0;
    if (charged) expensive++;
  }
  return undefined;
}

export function durableTool(tool: SreTool, cheap: ReadonlySet<string>): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const [rounds, thread, alertDoc] = await Promise.all([
        api.commit(async (tx) => roundsOf(await entriesSinceUser(tx, api.conversationId)), context),
        api.snapshot(ThreadDoc, api.conversationId, context),
        api.snapshot(AlertDoc, api.conversationId, context),
      ]);
      const verdict = gate(rounds, api.callId, thread?.budget ?? null, cheap);
      const labels = {
        component: "agent",
        alert: alertOf(alertDoc)?.name,
        conversation: api.conversationId,
        tool: tool.name,
      };
      if (verdict) {
        log.info("tool gated", { ...labels, isError: verdict.isError });
        return { output: [{ type: "text", text: verdict.text }], isError: verdict.isError };
      }
      const started = Date.now();
      log.info("tool start", labels);
      const out = await tool.execute(args, makeTimeWindow(alertOf(alertDoc) ?? { name: "", source: "", severity: "" }));
      log.info("tool end", { ...labels, isError: out.isError === true, durationMs: Date.now() - started });
      return { output: out.content, isError: out.isError === true };
    },
  });
}

function assessmentRejection(a: Assessment, corpus: string): string | undefined {
  if (!a.actionRequired) return undefined;
  const bareLink = /(^|[^\\])\[[^\]\n]+\](?!\()/;
  const lines = [
    ...a.affected.map((l, i) => [`affected[${i}]`, l] as const),
    ...a.evidence.map((l, i) => [`evidence[${i}]`, l] as const),
    ...a.actions.map((l, i) => [`actions[${i}]`, l] as const),
  ];
  const badLinks = lines.filter(([, l]) => bareLink.test(l)).map(([k, l]) => `${k}: ${l}`);
  if (badLinks.length) {
    return `Rejected: bare [label] without (url). Write [label](https://...) or drop the brackets. Then call submit_assessment again.\n\nOffending lines:\n${badLinks.join("\n")}`;
  }
  if (!a.affected.length) {
    return "Rejected: actionRequired is true, but affected is empty. Name each affected part, or set actionRequired to false.";
  }
  const ungrounded = a.evidence
    .map((l, i) => (isUngrounded(l, corpus) ? `evidence[${i}]: ${l}` : undefined))
    .filter((x): x is string => !!x);
  if (corpus && ungrounded.length) {
    return `Rejected: these evidence bullets share no number, identifier or path with any tool result. Cite what a tool returned, or drop the claim. Then call submit_assessment again.\n\nOffending lines:\n${ungrounded.join("\n")}`;
  }
  return undefined;
}

export const SUBMIT_ASSESSMENT = "submit_assessment";

export const submitAssessmentTool = defineTool({
  name: SUBMIT_ASSESSMENT,
  description:
    "Records the threat assessment verdict and ends the run. " +
    "If actionRequired is true, it rejects a bare [label] with no (url), an empty affected list, and an evidence line that shares nothing with a tool result. " +
    "A rejection names the lines. Fix them and call it again.",
  parameters: AssessmentSchema,
  replay: "safe",
  execute: async (a, api, context): Promise<ToolExecutionResult> => {
    const entries = await api.commit((tx) => allEntries(tx, api.conversationId), context);
    const rejected = assessmentRejection(a, buildEvidenceCorpus(messagesOf(entries)));
    if (rejected) return { output: [{ type: "text", text: rejected }] };
    await api.commit(async (tx) => {
      (await tx.doc(AssessmentDoc, api.conversationId)).assessment = json(a);
    }, context);
    return { output: [{ type: "text", text: "Assessment recorded." }], control: { terminate: true } };
  },
});

export const submitDiagnosisTool = defineTool({
  name: SUBMIT_DIAGNOSIS,
  description: SUBMIT_DIAGNOSIS_DESCRIPTION,
  parameters: DiagnosisSchema,
  replay: "safe",
  execute: async (d, api, context): Promise<ToolExecutionResult> => {
    const [entries, thread] = await Promise.all([
      api.commit((tx) => allEntries(tx, api.conversationId), context),
      api.snapshot(ThreadDoc, api.conversationId, context),
    ]);
    const corpus = buildEvidenceCorpus(messagesOf(entries));
    const review = await reviewDiagnosis(d, corpus, thread?.groundingRejected ?? false);
    if (review) {
      if (review.byGrounding) {
        await api.commit(async (tx) => {
          (await tx.doc(ThreadDoc, api.conversationId)).groundingRejected = true;
        }, context);
      }
      return { output: [{ type: "text", text: review.rejected }] };
    }
    await api.commit(async (tx) => {
      (await tx.doc(ThreadDoc, api.conversationId)).diagnosis = json(d);
    }, context);
    return { output: [{ type: "text", text: "Diagnosis recorded." }], control: { terminate: true } };
  },
});
