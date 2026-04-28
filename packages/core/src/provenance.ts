import type { EvidenceProvenanceEntry, InvestigationContext } from "./types.ts";

export function buildEvidenceProvenance(
  ctx: InvestigationContext,
): Record<string, EvidenceProvenanceEntry[]> {
  const out: Record<string, EvidenceProvenanceEntry[]> = {};
  for (const entry of ctx.audit) {
    for (const key of entry.evidenceKeys) {
      const list = out[key] ?? [];
      list.push({ tool: entry.tool, args: entry.args, loop: entry.loop, summary: entry.summary });
      out[key] = list;
    }
  }
  return out;
}
