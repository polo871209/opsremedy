/**
 * Extract the first JSON object from a possibly-noisy LLM response.
 * Tries in order:
 *   1. Whole text is already valid JSON.
 *   2. Text is wrapped in a ```json ... ``` (or unlabeled ``` ... ```) fence.
 *   3. First balanced { ... } substring (string-aware brace counter).
 * Returns the JSON text, or null if nothing parseable was found.
 */
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Fast path: already valid JSON object.
  if (trimmed.startsWith("{") && safeParse(trimmed) !== null) return trimmed;

  // 2. Code-fence path. Try every fence; prefer one that parses.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  for (let m = fenceRe.exec(trimmed); m !== null; m = fenceRe.exec(trimmed)) {
    const inner = m[1]?.trim();
    if (inner && safeParse(inner) !== null) return inner;
  }

  // 3. Balanced-brace fallback.
  return extractBalanced(trimmed);
}

function extractBalanced(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        if (safeParse(candidate) !== null) return candidate;
        return null;
      }
    }
  }
  return null;
}

export function safeParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
