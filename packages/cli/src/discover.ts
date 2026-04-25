import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findEnvKeys } from "@mariozechner/pi-ai";
import { parse as parseYaml } from "yaml";

// ---------------- gcloud ----------------

export interface GcpProject {
  projectId: string;
  name: string;
  projectNumber?: string;
}

export interface GcpDiscovery {
  gcloudInstalled: boolean;
  adcAvailable: boolean;
  projects: GcpProject[];
  /** Project marked active by `gcloud config get-value project`, if any. */
  activeProject?: string;
}

export async function discoverGcp(): Promise<GcpDiscovery> {
  const gcloudInstalled = await commandExists("gcloud");
  const adcAvailable = existsSync(
    join(homedir(), ".config", "gcloud", "application_default_credentials.json"),
  );

  if (!gcloudInstalled) {
    return { gcloudInstalled: false, adcAvailable, projects: [] };
  }

  const [projectsRaw, activeRaw] = await Promise.all([
    runCommand("gcloud", ["projects", "list", "--format=json"]).catch(() => null),
    runCommand("gcloud", ["config", "get-value", "project"]).catch(() => null),
  ]);

  const projects: GcpProject[] = [];
  if (projectsRaw) {
    try {
      const parsed = JSON.parse(projectsRaw) as Array<Record<string, unknown>>;
      for (const p of parsed) {
        const id = typeof p.projectId === "string" ? p.projectId : null;
        if (!id) continue;
        projects.push({
          projectId: id,
          name: typeof p.name === "string" ? p.name : id,
          ...(typeof p.projectNumber === "string" && { projectNumber: p.projectNumber }),
        });
      }
    } catch {
      // ignore parse errors
    }
  }

  const activeProject = activeRaw?.trim() || undefined;
  return {
    gcloudInstalled: true,
    adcAvailable,
    projects,
    ...(activeProject && { activeProject }),
  };
}

// ---------------- kubeconfig ----------------

export interface K8sContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  isCurrent: boolean;
}

export function defaultKubeconfigPath(): string {
  return join(homedir(), ".kube", "config");
}

interface KubeconfigShape {
  contexts?: Array<{
    name: string;
    context?: { cluster?: string; user?: string; namespace?: string };
  }>;
  "current-context"?: string;
}

export function discoverK8sContexts(kubeconfigPath?: string): K8sContext[] {
  const path = kubeconfigPath ?? defaultKubeconfigPath();
  if (!existsSync(path)) return [];
  let parsed: KubeconfigShape;
  try {
    parsed = parseYaml(readFileSync(path, "utf8")) as KubeconfigShape;
  } catch {
    return [];
  }
  const current = parsed["current-context"];
  return (parsed.contexts ?? []).map((c) => ({
    name: c.name,
    cluster: c.context?.cluster ?? "",
    user: c.context?.user ?? "",
    ...(c.context?.namespace && { namespace: c.context.namespace }),
    isCurrent: c.name === current,
  }));
}

// ---------------- prom / jaeger probes ----------------

export async function probePromUrl(url: string, timeoutMs = 1000): Promise<boolean> {
  return await probe(`${url.replace(/\/+$/, "")}/-/ready`, timeoutMs);
}

export async function probeJaegerUrl(url: string, timeoutMs = 1000): Promise<boolean> {
  return await probe(`${url.replace(/\/+$/, "")}/api/services`, timeoutMs);
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- pi-ai env var name discovery ----------------

/**
 * pi-ai's getApiKeyEnvVars is private; findEnvKeys only returns vars that are
 * already set. We probe-set every plausible env var name with a sentinel,
 * call findEnvKeys, and use whichever names come back. Restores env afterwards.
 *
 * Returns the canonical env var name(s) for a provider's API key, or [] if
 * the provider uses ambient credentials (e.g. amazon-bedrock, google-vertex).
 */
export function discoverProviderEnvVar(provider: string): string[] {
  const candidates = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "OPENCODE_API_KEY",
    "KIMI_API_KEY",
    "DEEPSEEK_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ];

  const SENTINEL = "__opsremedy_probe__";
  const restore: Array<[string, string | undefined]> = [];
  for (const name of candidates) {
    restore.push([name, process.env[name]]);
    process.env[name] = SENTINEL;
  }

  try {
    const found = findEnvKeys(provider) ?? [];
    return [...found];
  } finally {
    for (const [name, prev] of restore) {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  }
}

// ---------------- exec helpers ----------------

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await runCommand("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

function runCommand(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
