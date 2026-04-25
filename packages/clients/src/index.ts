import type { ClientRegistry } from "./types.ts";

export { loadScenarioClients } from "./fixtures.ts";
export { FixtureGcpLoggingClient } from "./gcp/fixture.ts";
export { RealGcpLoggingClient } from "./gcp/real.ts";
export { FixtureJaegerClient } from "./jaeger/fixture.ts";
export { RealJaegerClient, type RealJaegerClientOptions } from "./jaeger/real.ts";
export { FixtureK8sClient } from "./k8s/fixture.ts";
export { RealK8sClient, type RealK8sClientOptions } from "./k8s/real.ts";
export { FixturePromClient } from "./prom/fixture.ts";
export { RealPromClient, type RealPromClientOptions } from "./prom/real.ts";
export * from "./types.ts";

/**
 * Module-level client registry. Overridden by the CLI (real clients) or the
 * bench runner (fixture clients). Starts with throwing stubs so unconfigured
 * access fails loudly rather than silently.
 */
const THROWING: ClientRegistry = {
  gcp: {
    async search() {
      throw new Error("GCP client not configured — call setClients() first");
    },
  },
  prom: {
    async instant() {
      throw new Error("Prom client not configured");
    },
    async range() {
      throw new Error("Prom client not configured");
    },
    async alertRules() {
      throw new Error("Prom client not configured");
    },
  },
  jaeger: {
    async findTraces() {
      throw new Error("Jaeger client not configured");
    },
    async serviceDependencies() {
      throw new Error("Jaeger client not configured");
    },
  },
  k8s: {
    async listPods() {
      throw new Error("K8s client not configured");
    },
    async describe() {
      throw new Error("K8s client not configured");
    },
    async events() {
      throw new Error("K8s client not configured");
    },
    async podLogs() {
      throw new Error("K8s client not configured");
    },
  },
};

let registry: ClientRegistry = { ...THROWING };

export function getClients(): ClientRegistry {
  return registry;
}

export function setClients(next: Partial<ClientRegistry>): void {
  registry = { ...registry, ...next };
}

export function resetClients(): void {
  registry = { ...THROWING };
}
