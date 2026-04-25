import { getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentialRecord } from "./config.ts";

const REFRESH_SAFETY_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

export function isOAuthProvider(providerId: string): boolean {
  return getOAuthProviders().some((p) => p.id === providerId);
}

export function listOAuthProviderIds(): string[] {
  return getOAuthProviders().map((p) => p.id);
}

/**
 * Run the interactive OAuth login flow for the given provider.
 * Returns the credentials to persist. Throws on user abort or transport error.
 */
export async function runOAuthLogin(
  providerId: string,
  onPromptCode?: () => Promise<string>,
): Promise<OAuthCredentialRecord> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`No OAuth provider registered for ${providerId}`);

  const creds = await provider.login({
    onAuth: (info) => {
      console.log(`\nOpen this URL in your browser to sign in:`);
      console.log(`  ${info.url}`);
      if (info.instructions) console.log(`  ${info.instructions}`);
      console.log("");
    },
    onPrompt: async (p) => {
      // Prompt with readline-style input. Keeps secrets visible since this is
      // the manual-paste fallback when the local callback server can't bind.
      const value = await defaultPrompt(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}: `);
      return value;
    },
    onProgress: (msg) => console.log(msg),
    ...(onPromptCode !== undefined && { onManualCodeInput: onPromptCode }),
  });

  return normalize(creds);
}

/**
 * Ensure stored OAuth credentials have a non-expired access token. Refreshes
 * via the provider if needed. Returns the (possibly updated) creds plus the
 * API-key string to expose to pi-ai's stream functions.
 */
export async function ensureFreshOAuthToken(
  providerId: string,
  creds: OAuthCredentialRecord,
): Promise<{ creds: OAuthCredentialRecord; apiKey: string; refreshed: boolean }> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`No OAuth provider registered for ${providerId}`);

  const now = Date.now();
  let current = creds;
  let refreshed = false;

  if (typeof current.expires === "number" && current.expires - REFRESH_SAFETY_MS < now) {
    const next = await provider.refreshToken(current);
    current = normalize(next);
    refreshed = true;
  }

  const apiKey = provider.getApiKey(current);
  return { creds: current, apiKey, refreshed };
}

function normalize(c: {
  access: string;
  refresh: string;
  expires: number;
  [k: string]: unknown;
}): OAuthCredentialRecord {
  return { ...c, access: c.access, refresh: c.refresh, expires: c.expires };
}

async function defaultPrompt(message: string): Promise<string> {
  // Lazy-load readline to keep cold-path light.
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}
