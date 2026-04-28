import type { GatherPlanAudit, RCAReport, UsageSummary } from "./types.ts";

export interface InvestigationEventMap {
  input_loaded: { alert_id: string; source: "file" | "url" };
  investigation_start: { alert_id: string };
  evidence_gather_started: { loop: number };
  tool_plan: GatherPlanAudit;
  tool_started: { name: string; args: unknown };
  tool_finished: { toolCallId: string };
  diagnosis_started: { loop: number };
  validation_finished: { loop: number; category: string; confidence: number };
  final_result: RCAReport;
  investigation_end: { category: string; confidence: number; usage: UsageSummary };
}

export type InvestigationEventKind = keyof InvestigationEventMap;

export type InvestigationEvent = {
  [K in InvestigationEventKind]: { kind: K; detail: InvestigationEventMap[K] };
}[InvestigationEventKind];

export type InvestigationEventSink = (kind: string, detail?: unknown) => void;

export function emitInvestigationEvent<K extends InvestigationEventKind>(
  sink: InvestigationEventSink | undefined,
  kind: K,
  detail: InvestigationEventMap[K],
): void {
  sink?.(kind, detail);
}
