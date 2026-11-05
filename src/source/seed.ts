import { arr, compile, map, obj, str, unknown, type Static } from "@earendil-works/pi-schema";
import type { Alert } from "../alert.ts";
import { log } from "../utils/logger.ts";

const SeedCallSchema = obj({ tool: str(), args: map(unknown()) });
const SeedCallRuleSchema = obj({ alertNamePattern: str(), calls: arr(SeedCallSchema) });

export type SeedCall = Static<typeof SeedCallSchema>;
type SeedCallRule = Static<typeof SeedCallRuleSchema>;
export type SeedCallsConfig = SeedCallRule[];

const seedCallRule = compile(SeedCallRuleSchema);

let _cfg: SeedCallsConfig = [];

export function seedCalls(): SeedCallsConfig {
  return _cfg;
}

export async function loadSeedCalls(): Promise<void> {
  const path = process.env.OPSREMEDY_SEED_CALLS ?? "seed-calls.yaml";
  const file = Bun.file(path);
  if (!(await file.exists())) {
    log.info("seed calls config absent; feature off", { path });
    return;
  }
  try {
    const parsed: unknown = Bun.YAML.parse(await file.text()) ?? [];
    if (!Array.isArray(parsed)) throw new Error("top level must be a list of rules");
    const rules: SeedCallsConfig = [];
    for (const [i, rule] of parsed.entries()) {
      if (seedCallRule.check(rule)) rules.push(rule);
      else log.warn("seed call rule dropped: malformed", { path, rule: i, errors: seedCallRule.errors(rule) });
    }
    _cfg = rules;
    log.info("seed calls loaded", { path, rules: rules.length });
  } catch (e) {
    log.warn("seed calls config invalid; feature off", { path, error: String(e) });
  }
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
