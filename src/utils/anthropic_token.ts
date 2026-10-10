import { statSync, readFileSync } from "node:fs";

const DIR = "/var/run/opsremedy";
const CACHE_TTL_MS = 30_000;

export interface Creds {
  access: string;
  refresh: string;
  expires: number;
}

const fileCache = new Map<string, { value: string; mtimeMs: number; checkedAt: number }>();
let live: Creds | undefined;

function readField(key: string): string | undefined {
  try {
    const st = statSync(`${DIR}/${key}`);
    const now = Date.now();
    const hit = fileCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && now - hit.checkedAt < CACHE_TTL_MS) return hit.value;
    const value = readFileSync(`${DIR}/${key}`, "utf8").trim();
    if (!value) return undefined;
    fileCache.set(key, { value, mtimeMs: st.mtimeMs, checkedAt: now });
    return value;
  } catch {
    return undefined;
  }
}

function field(key: string): string | undefined {
  return readField(key) ?? process.env[key] ?? undefined;
}

export function getAnthropicToken(): string | undefined {
  if (live?.access) return live.access;
  return field("ANTHROPIC_OAUTH_TOKEN") ?? process.env.ANTHROPIC_API_KEY;
}

export function currentCreds(): { access?: string; refresh?: string; expires: number } {
  if (live) return { ...live };
  return {
    access: field("ANTHROPIC_OAUTH_TOKEN"),
    refresh: field("ANTHROPIC_REFRESH_TOKEN"),
    expires: Number(field("ANTHROPIC_TOKEN_EXPIRES_AT") ?? 0) || 0,
  };
}

export function setLiveCreds(creds: Creds): void {
  live = creds;
}

export function clearLiveCreds(): void {
  live = undefined;
  fileCache.clear();
}

export function invalidateAnthropicToken(): void {
  fileCache.clear();
}
