import type { PromInstantResult, PromRuleState, PromSeriesResult } from "@opsremedy/core/types";
import type { PromClient, PromInstantQuery, PromRangeQuery } from "../types.ts";

export interface FixturePromPayload {
  /** Keyed by exact PromQL query string. */
  instant?: Record<string, PromInstantResult>;
  range?: Record<string, PromSeriesResult>;
  alertRules?: PromRuleState[];
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
}
