import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { log } from "./logger.ts";

const DIR = "/var/run/opsremedy";
const CACHE_TTL_MS = 30_000;
const PROVIDER_ID = "anthropic";

export interface Creds {
  access: string;
  refresh: string;
  expires: number;
}

type OAuthCredential = Extract<Credential, { type: "oauth" }>;

const fileCache = new Map<string, { value: string; mtimeMs: number; checkedAt: number }>();

async function readField(key: string): Promise<string | undefined> {
  const file = Bun.file(`${DIR}/${key}`);
  try {
    const now = Date.now();
    const hit = fileCache.get(key);
    if (hit && hit.mtimeMs === file.lastModified && now - hit.checkedAt < CACHE_TTL_MS) return hit.value;
    const value = (await file.text()).trim();
    if (!value) return undefined;
    fileCache.set(key, { value, mtimeMs: file.lastModified, checkedAt: now });
    return value;
  } catch {
    return undefined;
  }
}

async function field(key: string): Promise<string | undefined> {
  return (await readField(key)) ?? process.env[key] ?? undefined;
}

async function mountedCredential(): Promise<OAuthCredential | undefined> {
  const refresh = await field("ANTHROPIC_REFRESH_TOKEN");
  if (!refresh) return undefined;
  return {
    type: "oauth",
    access: (await field("ANTHROPIC_OAUTH_TOKEN")) ?? "",
    refresh,
    expires: Number((await field("ANTHROPIC_TOKEN_EXPIRES_AT")) ?? 0) || 0,
  };
}

function isInvalidGrant(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (/invalid_grant/i.test(e.message)) return true;
  }
  return false;
}

/**
 * Holds the one Anthropic OAuth credential. The live credential (set by a refresh) wins over the mounted Secret files.
 * `Models` refreshes through `modify`, which persists each rotated pair with `patchSecret`.
 */
export class SecretCredentialStore implements CredentialStore {
  private live: OAuthCredential | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly patchSecret: (creds: Creds) => Promise<void>) {}

  private async current(): Promise<OAuthCredential | undefined> {
    return this.live ?? (await mountedCredential());
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === PROVIDER_ID ? this.current() : undefined;
  }

  async list() {
    return (await this.current()) ? [{ providerId: PROVIDER_ID, type: "oauth" as const }] : [];
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === PROVIDER_ID) this.clear();
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== PROVIDER_ID) return Promise.resolve(undefined);
    const run = this.tail.then(async () => {
      const before = await this.current();
      let next: Credential | undefined;
      try {
        next = await fn(before);
      } catch (e) {
        if (isInvalidGrant(e)) {
          this.clear();
          log.error("anthropic refresh token rejected (invalid_grant); reseed required (auth.md)", e);
        }
        throw e;
      }
      if (next?.type !== "oauth") return before;
      this.live = next;
      log.info("anthropic token refreshed", {
        expiresIso: new Date(next.expires).toISOString(),
        rotatedRefresh: next.refresh !== before?.refresh,
      });
      try {
        await this.patchSecret({ access: next.access, refresh: next.refresh, expires: next.expires });
      } catch (e) {
        log.error("token secret patch failed; a restart before the next refresh needs a reseed", e);
      }
      return next;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  expire(): Promise<void> {
    const run = this.tail.then(async () => {
      const cur = await this.current();
      if (cur) this.live = { ...cur, expires: 0 };
    });
    this.tail = run;
    return run;
  }

  private clear(): void {
    this.live = undefined;
    fileCache.clear();
  }
}
