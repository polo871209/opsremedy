import type { ServiceDep, TraceSummary } from "@opsremedy/core/types";
import type { JaegerClient, JaegerDepsQuery, JaegerTracesQuery } from "../types.ts";

export interface FixtureJaegerPayload {
  traces?: Record<string, TraceSummary[]>; // keyed by service name
  deps?: Record<string, ServiceDep[]>; // keyed by service name
}

export class FixtureJaegerClient implements JaegerClient {
  constructor(private readonly data: FixtureJaegerPayload) {}

  async findTraces(q: JaegerTracesQuery): Promise<TraceSummary[]> {
    const base = this.data.traces?.[q.service] ?? [];
    const minMs = q.minDurationMs ?? 0;
    return base.filter((t) => t.durationMs >= minMs).slice(0, q.limit);
  }

  async serviceDependencies(q: JaegerDepsQuery): Promise<ServiceDep[]> {
    return this.data.deps?.[q.service] ?? [];
  }
}
