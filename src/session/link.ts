import { state } from "../state.ts";

export const SESSION_SECRET = process.env.OPSREMEDY_SESSION_SECRET ?? "";

function sign(threadKey: string, exp: number): string {
  return new Bun.CryptoHasher("sha256", SESSION_SECRET).update(`${threadKey}:${exp}`).digest("base64url");
}

const hmacKey = () =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);

function signedUrl(path: "s" | "handoff", threadKey: string): string | undefined {
  const { publicBaseUrl, session } = state().cfg;
  if (!publicBaseUrl || !SESSION_SECRET || !session.linkTtlSeconds) return undefined;
  const exp = Math.floor(Date.now() / 1000) + session.linkTtlSeconds;
  return `${publicBaseUrl.replace(/\/$/, "")}/${path}/${encodeURIComponent(threadKey)}/${exp}.${sign(threadKey, exp)}`;
}

export function sessionUrl(threadKey: string): string | undefined {
  return signedUrl("s", threadKey);
}

export function handoffUrl(threadKey: string): string | undefined {
  return signedUrl("handoff", threadKey);
}

export async function verifySessionToken(threadKey: string, token: string): Promise<boolean> {
  if (!SESSION_SECRET || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.fromBase64(token.slice(dot + 1), { alphabet: "base64url" });
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await hmacKey(), sig, new TextEncoder().encode(`${threadKey}:${exp}`));
}
