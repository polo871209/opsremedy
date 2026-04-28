import type { Evidence, InvestigationContext, ToolCallAudit } from "@opsremedy/core/types";
import { Type } from "typebox";

export const IntentObject = Type.Object(
  {
    time_window: Type.Optional(
      Type.Union(
        [
          Type.Literal("5m"),
          Type.Literal("15m"),
          Type.Literal("1h"),
          Type.Literal("6h"),
          Type.Literal("24h"),
        ],
        { description: "Lookback window. Maps to per-tool minutes." },
      ),
    ),
    level: Type.Optional(
      Type.Union([Type.Literal("ERROR"), Type.Literal("WARN"), Type.Literal("INFO"), Type.Literal("DEBUG")], {
        description: "Severity floor for log queries (gcp_logs).",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 500,
        description: "Cap on returned items.",
      }),
    ),
    reason: Type.Optional(Type.String({ description: "Free text rationale recorded in audit." })),
  },
  { description: "Optional retrieval intent. Tools use only the fields they understand." },
);

const WINDOW_MINUTES = {
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
} as const;

export function intentWindowMinutes(window?: "5m" | "15m" | "1h" | "6h" | "24h"): number | undefined {
  return window ? WINDOW_MINUTES[window] : undefined;
}

export function alertTime(ctx: InvestigationContext): Date {
  const t = new Date(ctx.alert.fired_at);
  return Number.isNaN(t.getTime()) ? new Date() : t;
}

export const LEAD_IN_MINUTES = 5;

export function alertEndTime(ctx: InvestigationContext): Date {
  const closed = ctx.alert.annotations?.closed_at;
  if (closed) {
    const t = new Date(closed);
    if (!Number.isNaN(t.getTime())) return t;
  }
  return new Date();
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

export function windowAroundAlert(ctx: InvestigationContext, beforeMinutes = 0): TimeWindow {
  const fired = alertTime(ctx);
  const end = alertEndTime(ctx);
  return {
    from: new Date(fired.getTime() - (beforeMinutes + LEAD_IN_MINUTES) * 60_000),
    to: end,
  };
}

export function recordToolCall(
  ctx: InvestigationContext,
  entry: Omit<ToolCallAudit, "ms"> & { ms: number },
): void {
  ctx.tools_called.push(entry);
  ctx.loop_count++;
}

export function truncate(text: string, maxLen = 280): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

export function appendEvidence<K extends keyof Evidence>(
  ctx: InvestigationContext,
  key: K,
  items: Evidence[K] extends (infer U)[] | undefined ? U[] : never,
): void {
  const current = ctx.evidence[key] as unknown[] | undefined;
  if (current) {
    current.push(...items);
  } else {
    (ctx.evidence[key] as unknown) = items;
  }
}

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

export function recordEvidenceLink(ctx: InvestigationContext, source: string, url: string | undefined): void {
  if (!url) return;
  const links = (ctx.evidence.evidence_links as Record<string, string> | undefined) ?? {};
  if (links[source]) return;
  links[source] = url;
  ctx.evidence.evidence_links = links;
}
