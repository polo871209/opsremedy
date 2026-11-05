import { readFileSync } from "node:fs";
import { arr, compile, int, map, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { parse } from "yaml";

const ConfigSchema = obj({
  model: obj({
    provider: str(),
    investigation: str(),
    synthesis: str(),
    reasoning: opt(oneOf(["minimal", "low", "medium", "high"])),
  }),
  agent: obj({
    maxTurns: int({ minimum: 1 }),
    toolExecution: oneOf(["sequential", "parallel"]),
    maxConcurrent: int({ minimum: 1 }),
    turnsBySeverity: opt(map(int({ minimum: 1 }))),
    stallSeconds: int({ minimum: 1 }),
  }),
  systemContext: str(),
  assessContext: str(),
  timezone: str(),
  gcp: obj({ project: str() }),
  kubernetes: obj({ namespace: str() }),
  prometheus: obj({ url: str(), datasourceUid: str() }),
  jaeger: obj({ addr: str() }),
  kafka: opt(obj({ brokers: arr(str()) })),
  grafana: obj({ url: str() }),
  session: obj({ dbPath: str(), ttlSeconds: int({ minimum: 1 }), linkTtlSeconds: int({ minimum: 1 }) }),
  notify: obj({ flapWindowSeconds: int({ minimum: 0 }) }),
  publicBaseUrl: str(),
  maintainerOpenIds: opt(arr(str())),
  feeds: opt(arr(obj({ url: str(), chatId: str() }))),
  deploy: opt(obj({ repository: str(), ref: str(), workflow: str() })),
});

export type Config = Static<typeof ConfigSchema>;

const config = compile(ConfigSchema);

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
  const raw = interp(parse(readFileSync(path, "utf8")));
  if (config.check(raw)) return raw;
  const problems = config.errors(raw).map((e) => `${e.path || "/"}: ${e.message}`);
  throw new Error(`${path} is invalid: ${problems.join("; ")}`);
}
