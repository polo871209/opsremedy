import type { Evidence, InvestigationContext, ToolCallAudit } from "@opsremedy/core/types";

/** Parse the alert's `fired_at` into a Date; fall back to `Date.now()`. */
export function alertTime(ctx: InvestigationContext): Date {
  const t = new Date(ctx.alert.fired_at);
  return Number.isNaN(t.getTime()) ? new Date() : t;
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

export function windowAroundAlert(
  ctx: InvestigationContext,
  beforeMinutes: number,
  afterMinutes = 5,
): TimeWindow {
  const center = alertTime(ctx);
  return {
    from: new Date(center.getTime() - beforeMinutes * 60_000),
    to: new Date(center.getTime() + afterMinutes * 60_000),
  };
}

export function recordToolCall(
  ctx: InvestigationContext,
  entry: Omit<ToolCallAudit, "ms"> & { ms: number },
): void {
  ctx.tools_called.push(entry);
  ctx.loop_count++;
}

/** Truncate a multi-line string so LLM-visible summaries stay small. */
export function truncate(text: string, maxLen = 280): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

/**
 * Append items to an array-shaped evidence bucket, creating the array on
 * first use. Replaces the boilerplate
 *   const existing = ctx.evidence.foo ?? [];
 *   ctx.evidence.foo = [...existing, ...items];
 */
export function appendEvidence<K extends keyof Evidence>(
  ctx: InvestigationContext,
  key: K,
  items: Evidence[K] extends (infer U)[] | undefined ? U[] : never,
): void {
  const current = (ctx.evidence[key] as unknown as unknown[] | undefined) ?? [];
  (ctx.evidence[key] as unknown) = [...current, ...items];
}

/**
 * Set a sub-key on a record-shaped evidence bucket, creating the record on
 * first use. Replaces the boilerplate
 *   const store = ctx.evidence.foo ?? {};
 *   store[subKey] = value;
 *   ctx.evidence.foo = store;
 */
export function setEvidenceMapEntry<K extends keyof Evidence>(
  ctx: InvestigationContext,
  key: K,
  subKey: string,
  value: unknown,
): void {
  const current = (ctx.evidence[key] as Record<string, unknown> | undefined) ?? {};
  current[subKey] = value;
  (ctx.evidence[key] as unknown) = current;
}
