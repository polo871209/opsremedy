import type { Message } from "@earendil-works/pi-ai";

const echoesRejectedClaims = (toolName: string) => toolName === "submit_diagnosis";

export function buildEvidenceCorpus(messages: Message[]): string {
  return messages
    .flatMap((m) => (m.role === "toolResult" && !echoesRejectedClaims(m.toolName) ? m.content : []))
    .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
    .join("\n");
}

const TOKEN_RE = /\d+|[a-z][a-z0-9_-]{5,}/gi;

function tokensOf(line: string): string[] {
  return line.match(TOKEN_RE) ?? [];
}

export function isUngrounded(line: string, corpus: string): boolean {
  const tokens = tokensOf(line.toLowerCase());
  if (tokens.length === 0) return false;
  const haystack = corpus.toLowerCase();
  return !tokens.some((t) => haystack.includes(t));
}
