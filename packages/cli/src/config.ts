import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_LARK_DOMAIN,
  DEFAULT_LARK_LOCALE,
  DEFAULT_LARK_RECEIVE_TYPE,
  DEFAULT_LARK_SEND_ON,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  type LarkConfig,
} from "@opsremedy/notify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Persisted (non-secret) configuration. Mirrors the env vars previously expected
 * in `.env`, but lives in $XDG_CONFIG_HOME/opsremedy/config.yml so it survives
 * across shells. Env vars still win over file values at runtime.
 */
export interface OpsremedyConfig {
  llm?: {
    provider: string;
    model: string;
  };
  gcp?: {
    project_id?: string;
    /** Path to ADC JSON. If unset, ADC discovery applies. */
    credentials_path?: string;
  };
  prom?: {
    url: string;
    bearer_token_env?: string; // name of env var holding token, optional
    user?: string;
  };
  jaeger?: {
    url: string;
  };
  k8s?: {
    kubeconfig?: string;
    context?: string;
  };
  agent?: {
    max_tool_calls?: number;
  };
  lark?: {
    enabled?: boolean;
    /** "lark" → open.larksuite.com (intl); "feishu" → open.feishu.cn. */
    domain?: "lark" | "feishu";
    receive_id_type?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
    receive_id?: string;
    locale?: "en_US" | "zh_CN";
    send_on?: "always" | "non_healthy" | "low_confidence";
    low_confidence_threshold?: number;
  };
}

export interface OAuthCredentialRecord {
  refresh: string;
  access: string;
  /** Unix epoch ms when access token expires. */
  expires: number;
  [key: string]: unknown;
}

/**
 * Secret values stored separately from `config.yml`, with chmod 0600.
 * Keyed by pi-ai provider id (e.g. `anthropic`, `openai`).
 */
export interface OpsremedyCredentials {
  /** Map provider id → API key (for providers that use static keys). */
  llm_keys?: Record<string, string>;
  /** Map provider id → OAuth credentials (for subscription-based providers). */
  llm_oauth?: Record<string, OAuthCredentialRecord>;
  /** Optional infra secrets. */
  prom_bearer_token?: string;
  prom_password?: string;
  jaeger_token?: string;
  lark?: {
    app_id?: string;
    app_secret?: string;
  };
}

export const DEFAULT_PROM_URL = "http://localhost:9090";
export const DEFAULT_JAEGER_URL = "http://localhost:16686";
export const DEFAULT_KUBECONFIG = join(homedir(), ".kube", "config");
export const DEFAULT_MAX_TOOL_CALLS = 20;

// ---------------- paths ----------------

function xdgConfigHome(): string {
  return Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function xdgDataHome(): string {
  return Bun.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export function configPath(): string {
  return join(xdgConfigHome(), "opsremedy", "config.yml");
}

export function credentialsPath(): string {
  return join(xdgDataHome(), "opsremedy", "credentials.yml");
}

// ---------------- load ----------------

export function loadConfig(): OpsremedyConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return (parseYaml(readFileSync(path, "utf8")) as OpsremedyConfig) ?? {};
  } catch (e) {
    throw new Error(`Failed to parse ${path}: ${(e as Error).message}`);
  }
}

export function loadCredentials(): OpsremedyCredentials {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    return (parseYaml(readFileSync(path, "utf8")) as OpsremedyCredentials) ?? {};
  } catch (e) {
    throw new Error(`Failed to parse ${path}: ${(e as Error).message}`);
  }
}

// ---------------- save ----------------

export function saveConfig(cfg: OpsremedyConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(cfg), "utf8");
  return path;
}

export function saveCredentials(creds: OpsremedyCredentials): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(creds), "utf8");
  // Best-effort lockdown. Skip on Windows-like FS where chmod is a no-op.
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

// ---------------- resolved view ----------------

/**
 * Final values used by the CLI, env > config > default.
 * Returned shape matches what `bootstrap.ts` and `runInvestigation` consume.
 */
export interface ResolvedSettings {
  llm: { provider: string; model: string };
  gcp: { projectId: string | undefined; credentialsPath: string | undefined };
  prom: {
    url: string;
    bearerToken: string | undefined;
    basicAuth: { user: string; password: string } | undefined;
  };
  jaeger: { url: string; token: string | undefined };
  k8s: { kubeconfigPath: string | undefined; context: string | undefined };
  agent: { maxToolCalls: number };
  /** Undefined when Lark is disabled or unconfigured. */
  lark: LarkConfig | undefined;
}

export function resolveSettings(cfg: OpsremedyConfig, creds: OpsremedyCredentials): ResolvedSettings {
  const env = Bun.env;

  const provider = env.OPSREMEDY_LLM_PROVIDER ?? cfg.llm?.provider ?? "anthropic";
  const model = env.OPSREMEDY_LLM_MODEL ?? cfg.llm?.model ?? "claude-sonnet-4-5-20250929";

  const promUrl = env.PROM_URL ?? cfg.prom?.url ?? DEFAULT_PROM_URL;
  const promBearer = env.PROM_BEARER_TOKEN ?? creds.prom_bearer_token;
  const promUser = env.PROM_USER ?? cfg.prom?.user;
  const promPass = env.PROM_PASSWORD ?? creds.prom_password;

  const jaegerUrl = env.JAEGER_URL ?? cfg.jaeger?.url ?? DEFAULT_JAEGER_URL;
  const jaegerToken = env.JAEGER_TOKEN ?? creds.jaeger_token;

  const kubeconfig = env.KUBECONFIG ?? cfg.k8s?.kubeconfig;
  const k8sContext = env.OPSREMEDY_K8S_CONTEXT ?? cfg.k8s?.context;

  const gcpProject = env.GCP_PROJECT_ID ?? cfg.gcp?.project_id;
  const gcpCreds = env.GOOGLE_APPLICATION_CREDENTIALS ?? cfg.gcp?.credentials_path;

  const maxToolCalls = Number(
    env.OPSREMEDY_MAX_TOOL_CALLS ?? cfg.agent?.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS,
  );

  return {
    llm: { provider, model },
    gcp: { projectId: gcpProject, credentialsPath: gcpCreds },
    prom: {
      url: promUrl,
      bearerToken: promBearer,
      basicAuth: promUser && promPass ? { user: promUser, password: promPass } : undefined,
    },
    jaeger: { url: jaegerUrl, token: jaegerToken },
    k8s: { kubeconfigPath: kubeconfig, context: k8sContext },
    agent: { maxToolCalls: Number.isFinite(maxToolCalls) ? maxToolCalls : DEFAULT_MAX_TOOL_CALLS },
    lark: resolveLarkConfig(cfg, creds),
  };
}

/**
 * Build a fully-resolved LarkConfig or undefined. Returns undefined when
 * either disabled in config or missing the credentials needed to send.
 * Env > file > defaults, matching the rest of the resolver.
 */
function resolveLarkConfig(cfg: OpsremedyConfig, creds: OpsremedyCredentials): LarkConfig | undefined {
  const env = Bun.env;
  const enabled = cfg.lark?.enabled === true;
  if (!enabled) return undefined;

  const appId = env.OPSREMEDY_LARK_APP_ID ?? creds.lark?.app_id;
  const appSecret = env.OPSREMEDY_LARK_APP_SECRET ?? creds.lark?.app_secret;
  const receiveId = env.OPSREMEDY_LARK_RECEIVE_ID ?? cfg.lark?.receive_id;
  if (!appId || !appSecret || !receiveId) return undefined;

  const domainRaw = env.OPSREMEDY_LARK_DOMAIN ?? cfg.lark?.domain ?? DEFAULT_LARK_DOMAIN;
  const domain: LarkConfig["domain"] = domainRaw === "feishu" ? "feishu" : "lark";

  return {
    enabled: true,
    domain,
    appId,
    appSecret,
    receiveIdType: cfg.lark?.receive_id_type ?? DEFAULT_LARK_RECEIVE_TYPE,
    receiveId,
    locale: cfg.lark?.locale ?? DEFAULT_LARK_LOCALE,
    sendOn: cfg.lark?.send_on ?? DEFAULT_LARK_SEND_ON,
    lowConfidenceThreshold: cfg.lark?.low_confidence_threshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  };
}

/**
 * Push secrets into process.env so pi-ai's built-in key resolution finds them.
 * Provider-specific env var names come from pi-ai's `findEnvKeys`.
 */
export function applyCredentialsToEnv(creds: OpsremedyCredentials, envKeyNames: Map<string, string[]>): void {
  for (const [provider, key] of Object.entries(creds.llm_keys ?? {})) {
    const names = envKeyNames.get(provider) ?? [];
    for (const name of names) {
      if (!process.env[name]) process.env[name] = key;
    }
  }
}
