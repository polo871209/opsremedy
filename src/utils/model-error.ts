import { invalidateAnthropicToken } from "./anthropic_token.ts";
import { refreshNow } from "./token-refresh.ts";
import { track } from "./inflight.ts";
import { log } from "./logger.ts";

const AUTH_MARKERS = [
  "authentication_error",
  "permission_error",
  "invalid_api_key",
  "invalid x-api-key",
  "invalid_grant",
  "oauth access token has been revoked",
  "oauth token has expired",
  "anthropic_oauth_token not set",
];

function isAuthError(err: string): boolean {
  const s = err.toLowerCase();
  if (AUTH_MARKERS.some((m) => s.includes(m))) return true;
  return /\b(401|403)\b/.test(s) && /unauthor|forbidden|credential|token|api key/.test(s);
}

const AUTH_MESSAGE =
  "The agent's Anthropic credential was rejected, so no model call can run. " +
  "Reseed it with `scripts/seed-refresh-token.sh`, then ask again. Runbook: auth.md.";

const SECRET_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{20,})/g;
const MAX_ERROR_CHARS = 400;

export function userFacingError(err: string | undefined): string {
  const raw = (err ?? "").trim();
  if (!raw) return "unknown error";
  if (isAuthError(raw)) return AUTH_MESSAGE;
  const clean = raw.replace(/\s+/g, " ").replace(SECRET_RE, "[redacted]");
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

export function noteModelError(err: string | undefined, fields: Record<string, unknown> = {}): boolean {
  if (!err || !isAuthError(err)) return false;
  invalidateAnthropicToken();
  log.error("anthropic credential rejected; reseed required (auth.md)", undefined, {
    ...fields,
    detail: err.slice(0, 200).replace(SECRET_RE, "[redacted]"),
  });
  track(refreshNow("auth-error").catch(() => {}));
  return true;
}
