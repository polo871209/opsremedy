import type { InvestigationContext, ToolCallAudit } from "@opsremedy/core/types";

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
