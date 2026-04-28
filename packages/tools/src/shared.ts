import type { Evidence, InvestigationContext, ToolCallAudit } from "@opsremedy/core/types";
import { Type } from "typebox";

/**
 * Per-tool retrieval intent. Optional hint the LLM populates to scope a call:
 * how far back to look, what severity floor, how many items it wants. Each
 * tool's `run` reads only the fields that apply to it; unknown fields are
 * harmless. Back-compat: omitting `intent` preserves existing behaviour.
 *
 * Mirrors OpenSRE's `RetrievalControlsMap` but expressed per-call rather than
 * carried in a separate plan structure.
 */
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

/** Time-window literal → minutes. */
export function intentWindowMinutes(window?: "5m" | "15m" | "1h" | "6h" | "24h"): number | undefined {
  switch (window) {
    case "5m":
      return 5;
    case "15m":
      return 15;
    case "1h":
      return 60;
    case "6h":
      return 360;
    case "24h":
      return 1440;
    default:
      return undefined;
  }
}

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

/**
 * Record a deep-link URL for an evidence source key. No-op when `url` is
 * undefined (fixture clients return undefined). First write wins so a later
 * narrower query doesn't replace an earlier broader one — keeps the link
 * pointing at something that returned data.
 */
export function recordEvidenceLink(ctx: InvestigationContext, source: string, url: string | undefined): void {
  if (!url) return;
  const links = (ctx.evidence.evidence_links as Record<string, string> | undefined) ?? {};
  if (links[source]) return;
  links[source] = url;
  ctx.evidence.evidence_links = links;
}
