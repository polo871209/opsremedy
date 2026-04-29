import type {
  PromInstantResult,
  PromMetricMetadata,
  PromRuleState,
  PromSeriesResult,
  PromTarget,
} from "@opsremedy/core/types";
import type {
  PromClient,
  PromInstantQuery,
  PromMetadataQuery,
  PromMetricsListQuery,
  PromRangeQuery,
  PromTargetsQuery,
} from "../types.ts";

export interface FixturePromPayload {
  /** Keyed by exact PromQL query string. */
  instant?: Record<string, PromInstantResult>;
  range?: Record<string, PromSeriesResult>;
  alertRules?: PromRuleState[];
  metrics?: string[];
  metadata?: PromMetricMetadata[];
  targets?: PromTarget[];
}

const EMPTY_INSTANT: PromInstantResult = { resultType: "vector", series: [] };
const EMPTY_RANGE: PromSeriesResult = { series: [] };

/**
 * Fixture Prom client — returns pre-recorded responses keyed by query string.
 * Unknown queries return an empty result (so the scenario can prove the agent
 * asked for the right metric even if the fixture doesn't supply data).
 */
export class FixturePromClient implements PromClient {
  constructor(private readonly data: FixturePromPayload) {}

  async instant(q: PromInstantQuery): Promise<PromInstantResult> {
    return this.data.instant?.[q.query] ?? EMPTY_INSTANT;
  }

  async range(q: PromRangeQuery): Promise<PromSeriesResult> {
    return this.data.range?.[q.query] ?? EMPTY_RANGE;
  }

  async alertRules(): Promise<PromRuleState[]> {
    return this.data.alertRules ?? [];
  }

  async listMetrics(q: PromMetricsListQuery): Promise<string[]> {
    let names = this.data.metrics ?? [];
    if (q.contains) {
      const needle = q.contains.toLowerCase();
      names = names.filter((n) => n.toLowerCase().includes(needle));
    }
    return names.slice(0, q.limit ?? 200);
  }

  async metricMetadata(q: PromMetadataQuery): Promise<PromMetricMetadata[]> {
    const all = this.data.metadata ?? [];
    return q.metric ? all.filter((m) => m.metric === q.metric) : all;
  }

  async targets(q: PromTargetsQuery): Promise<PromTarget[]> {
    const all = this.data.targets ?? [];
    return q.job ? all.filter((t) => t.job === q.job) : all;
  }

  uiUrl(): undefined {
    return undefined;
  }
}
