/** Cap string with ellipsis suffix. Returns input unchanged if within limit. */
export function truncate(s: string, max: number, suffix = "…"): string {
  if (s.length <= max) return s;
  if (max <= suffix.length) return s.slice(0, max);
  return s.slice(0, max - suffix.length) + suffix;
}

/**
 * Limit list to first N items. If overflow, append "(+K more)" as last entry.
 * Used for causal_chain, validated_claims, etc.
 */
export function capList<T>(items: T[], max: number): { kept: T[]; overflow: number } {
  if (items.length <= max) return { kept: items, overflow: 0 };
  return { kept: items.slice(0, max), overflow: items.length - max };
}

/** Approximate JSON-encoded byte size. Used to gate against Lark 30KB card cap. */
export function jsonByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
