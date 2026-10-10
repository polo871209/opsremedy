import { createHmac, timingSafeEqual } from "node:crypto";
import { state } from "../state.ts";

export const SESSION_SECRET = process.env.OPSREMEDY_SESSION_SECRET ?? "";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(threadKey: string, exp: number): string {
  return b64url(createHmac("sha256", SESSION_SECRET).update(`${threadKey}:${exp}`).digest());
}

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

export function verifySessionToken(threadKey: string, token: string): boolean {
  if (!SESSION_SECRET || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = sign(threadKey, exp);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
