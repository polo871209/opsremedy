import type { ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { DiagnosisSchema, type Diagnosis } from "../diagnosis.ts";
import { buildEvidenceCorpus } from "../tools/evidence.ts";
import { reviewDiagnosis, SUBMIT_DIAGNOSIS, SUBMIT_DIAGNOSIS_DESCRIPTION } from "../tools/registry.ts";
import type { SreTool } from "../tools/types.ts";
import { log } from "../utils/logger.ts";
import { makeTimeWindow } from "../utils/timewindow.ts";
import { AlertDoc, alertOf, json, ThreadDoc } from "./docs.ts";
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
        return { content: [{ type: "text", text: verdict.text }], isError: verdict.isError };
      }
      const started = Date.now();
      log.info("tool start", labels);
      const out = await tool.execute(args, makeTimeWindow(alertOf(alertDoc) ?? { name: "", source: "", severity: "" }));
      log.info("tool end", { ...labels, isError: out.isError === true, durationMs: Date.now() - started });
      return { content: out.content, isError: out.isError === true };
    },
  });
}

export const submitDiagnosisTool = defineTool({
  name: SUBMIT_DIAGNOSIS,
  description: SUBMIT_DIAGNOSIS_DESCRIPTION,
  parameters: DiagnosisSchema,
  replay: "safe",
  execute: async (args, api, context): Promise<ToolExecutionResult> => {
    const d = args as Diagnosis;
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
      return { content: [{ type: "text", text: review.rejected }] };
    }
    await api.commit(async (tx) => {
      (await tx.doc(ThreadDoc, api.conversationId)).diagnosis = json(d);
    }, context);
    return { content: [{ type: "text", text: "Diagnosis recorded." }], control: { terminate: true } };
  },
});
