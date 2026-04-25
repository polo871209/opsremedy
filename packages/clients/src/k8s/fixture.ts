import type { EventSummary, PodSummary } from "@opsremedy/core/types";
import type {
  K8sClient,
  K8sDescribeQuery,
  K8sEventsQuery,
  K8sListPodsQuery,
  K8sLogsQuery,
} from "../types.ts";

export interface FixtureK8sPayload {
  pods?: Record<string, PodSummary[]>; // keyed by namespace
  events?: Record<string, EventSummary[]>; // keyed by namespace
  describe?: Record<string, string>; // key: `${kind}/${name}` or `${kind}/${name}@${namespace}`
  logs?: Record<string, string[]>; // key: `${namespace}/${pod}` or `${namespace}/${pod}/${container}`
}

export class FixtureK8sClient implements K8sClient {
  constructor(private readonly data: FixtureK8sPayload) {}

  async listPods(q: K8sListPodsQuery): Promise<PodSummary[]> {
    return this.data.pods?.[q.namespace] ?? [];
  }

  async describe(q: K8sDescribeQuery): Promise<string> {
    const keys = [`${q.kind}/${q.name}${q.namespace ? `@${q.namespace}` : ""}`, `${q.kind}/${q.name}`];
    for (const key of keys) {
      const value = this.data.describe?.[key];
      if (value) return value;
    }
    return `Fixture: no describe available for ${q.kind}/${q.name}.`;
  }

  async events(q: K8sEventsQuery): Promise<EventSummary[]> {
    return this.data.events?.[q.namespace] ?? [];
  }

  async podLogs(q: K8sLogsQuery): Promise<string[]> {
    const keys = [`${q.namespace}/${q.pod}/${q.container ?? ""}`, `${q.namespace}/${q.pod}`];
    for (const key of keys) {
      const value = this.data.logs?.[key];
      if (value) return value.slice(-q.tailLines);
    }
    return [];
  }
}
