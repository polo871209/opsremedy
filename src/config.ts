import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Config {
  model: {
    provider: string;
    investigation: string;
    synthesis: string;
    reasoning?: "minimal" | "low" | "medium" | "high";
  };
  agent: {
    maxTurns: number;
    toolExecution: "sequential" | "parallel";
    maxConcurrent: number;
    turnsBySeverity?: Record<string, number>;
    stallSeconds: number;
  };
  systemContext: string;
  timezone: string;
  gcp: { project: string };
  kubernetes: { namespace: string };
  prometheus: { url: string; datasourceUid: string };
  jaeger: { addr: string };
  kafka?: { brokers: string[] };
  grafana: { url: string };
  session: { dbPath: string; ttlSeconds: number; linkTtlSeconds: number };
  notify: { flapWindowSeconds: number };
  publicBaseUrl: string;
  maintainerOpenIds?: string[];
}

function interp(v: unknown): unknown {
  if (typeof v === "string") {
    return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
      const value = process.env[k];
      if (value === undefined) throw new Error(`config.yaml references \${${k}}, which is not set`);
      return value;
    });
  }
  if (Array.isArray(v)) return v.map(interp);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, vv]) => [k, interp(vv)]));
  }
  return v;
}

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8"));
  return interp(raw) as Config;
}
