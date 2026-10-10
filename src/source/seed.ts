import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { Alert } from "../alert.ts";
import { log } from "../utils/logger.ts";

interface SeedCallSpec {
  tool: string;
  args: Record<string, unknown>;
}
interface SeedCallRule {
  alertNamePattern: string;
  calls: SeedCallSpec[];
}
export type SeedCallsConfig = SeedCallRule[];

export interface SeedCall {
  tool: string;
  args: Record<string, unknown>;
}

function isRule(v: unknown): v is SeedCallRule {
  if (!v || typeof v !== "object") return false;
  const rule = v as Partial<SeedCallRule>;
  return (
    typeof rule.alertNamePattern === "string" &&
    Array.isArray(rule.calls) &&
    rule.calls.every((c) => typeof c?.tool === "string" && !!c.args && typeof c.args === "object")
  );
}

let _cfg: SeedCallsConfig | undefined;
export function loadSeedCalls(): SeedCallsConfig {
  if (_cfg) return _cfg;
  const path = process.env.OPSREMEDY_SEED_CALLS ?? "seed-calls.yaml";
  if (!existsSync(path)) {
    log.info("seed calls config absent; feature off", { path });
    _cfg = [];
    return _cfg;
  }
  try {
    const parsed: unknown = parse(readFileSync(path, "utf8")) ?? [];
    if (!Array.isArray(parsed)) throw new Error("top level must be a list of rules");
    _cfg = parsed.filter(isRule);
    if (_cfg.length < parsed.length)
      log.warn("seed call rules dropped: malformed", { path, dropped: parsed.length - _cfg.length });
    log.info("seed calls loaded", { path, rules: _cfg.length });
  } catch (e) {
    log.warn("seed calls config invalid; feature off", { path, error: String(e) });
    _cfg = [];
  }
  return _cfg;
}

export interface SeedContext {
  service: string;
  name: string;
  severity: string;
  namespace: string;
  labels: Record<string, string>;
  window: { start: string; end: string };
}

export function buildSeedContext(
  alert: Alert,
  window: { start: string; end: string },
  defaultNamespace: string,
): SeedContext {
  return {
    service: alert.service ?? "",
    name: alert.name,
    severity: alert.severity,
    namespace: alert.labels?.namespace ?? defaultNamespace,
    labels: alert.labels ?? {},
    window,
  };
}

function lookup(ctx: SeedContext, path: string): string {
  const parts = path.split(".");
  let v: unknown = ctx;
  for (const p of parts) {
    if (v == null || typeof v !== "object") return "";
    v = (v as Record<string, unknown>)[p];
  }
  return v == null ? "" : String(v);
}

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function fillTemplate(s: string, ctx: SeedContext): { value: string; missing: boolean } {
  let missing = false;
  const value = s.replace(TEMPLATE_RE, (_m, path: string) => {
    const v = lookup(ctx, path);
    if (!v) missing = true;
    return v;
  });
  return { value, missing };
}

export function resolveSeedCalls(alert: Alert, cfg: SeedCallsConfig, ctx: SeedContext): SeedCall[] {
  const out: SeedCall[] = [];
  for (const rule of cfg) {
    let re: RegExp;
    try {
      re = new RegExp(rule.alertNamePattern, "i");
    } catch {
      continue;
    }
    if (!re.test(alert.name)) continue;
    for (const call of rule.calls) {
      const args: Record<string, unknown> = {};
      let incomplete = false;
      for (const [k, v] of Object.entries(call.args)) {
        if (typeof v !== "string") {
          args[k] = v;
          continue;
        }
        const { value, missing } = fillTemplate(v, ctx);
        args[k] = value;
        if (missing) incomplete = true;
      }
      if (!incomplete) out.push({ tool: call.tool, args });
    }
  }
  return out;
}
