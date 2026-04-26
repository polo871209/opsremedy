/**
 * Roll up token + cost usage from a sequence of pi-ai messages.
 * Only assistant messages carry `usage`; others are ignored.
 *
 * `UsageTotal` and `ZERO_USAGE` re-export the canonical types from
 * `../types.ts`. Kept here as named aliases because most internal call
 * sites refer to them via this util.
 */

import { type UsageSummary, ZERO_USAGE } from "../types.ts";

export type UsageTotal = UsageSummary;
export { ZERO_USAGE };

interface AssistantUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface MessageLike {
  role?: string;
  usage?: AssistantUsage;
}

export function sumUsage(messages: readonly MessageLike[]): UsageTotal {
  const total = { ...ZERO_USAGE };
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    const u = msg.usage;
    total.input_tokens += u.input ?? 0;
    total.output_tokens += u.output ?? 0;
    total.cache_read_tokens += u.cacheRead ?? 0;
    total.cache_write_tokens += u.cacheWrite ?? 0;
    total.total_tokens += u.totalTokens ?? 0;
    total.cost_usd += u.cost?.total ?? 0;
  }
  // Round cost to 6 decimals (sub-cent precision).
  total.cost_usd = Math.round(total.cost_usd * 1_000_000) / 1_000_000;
  return total;
}

export function addUsage(a: UsageTotal, b: UsageTotal): UsageTotal {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost_usd: Math.round((a.cost_usd + b.cost_usd) * 1_000_000) / 1_000_000,
  };
}
