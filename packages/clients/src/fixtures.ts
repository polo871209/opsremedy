import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureGcpLoggingClient, type FixtureGcpPayload } from "./gcp/fixture.ts";
import { FixtureJaegerClient, type FixtureJaegerPayload } from "./jaeger/fixture.ts";
import { FixtureK8sClient, type FixtureK8sPayload } from "./k8s/fixture.ts";
import { FixturePromClient, type FixturePromPayload } from "./prom/fixture.ts";
import type { ClientRegistry } from "./types.ts";

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`Failed to parse fixture ${path}: ${(e as Error).message}`);
  }
}

/**
 * Load all fixtures for a scenario directory into a client registry.
 * Expects files: gcp_logs.json, prom.json, jaeger.json, k8s.json.
 */
export function loadScenarioClients(scenarioDir: string): ClientRegistry {
  const gcp = loadJson<FixtureGcpPayload>(join(scenarioDir, "gcp_logs.json"), { logs: [] });
  const prom = loadJson<FixturePromPayload>(join(scenarioDir, "prom.json"), {});
  const jaeger = loadJson<FixtureJaegerPayload>(join(scenarioDir, "jaeger.json"), {});
  const k8s = loadJson<FixtureK8sPayload>(join(scenarioDir, "k8s.json"), {});

  return {
    gcp: new FixtureGcpLoggingClient(gcp),
    prom: new FixturePromClient(prom),
    jaeger: new FixtureJaegerClient(jaeger),
    k8s: new FixtureK8sClient(k8s),
  };
}
