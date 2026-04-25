export function formatExpiry(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Soft model preference: pick a sonnet/4-5 if anthropic, gpt-4o or gpt-5 if
 * openai, gemini-2/1.5 if google, else first model in the list.
 */
export function preferredModelFor(provider: string, modelIds: string[]): string {
  const preferences: Record<string, RegExp[]> = {
    anthropic: [/claude-sonnet-4-5-202\d{5}/, /claude-sonnet-4-5/, /claude-sonnet/],
    openai: [/^gpt-5/, /^gpt-4o/, /^gpt-4/],
    google: [/^gemini-2/, /^gemini-1\.5/],
  };
  const list = preferences[provider] ?? [];
  for (const re of list) {
    const hit = modelIds.find((id) => re.test(id));
    if (hit) return hit;
  }
  return modelIds[0] ?? "";
}
