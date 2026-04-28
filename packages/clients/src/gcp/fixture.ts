import type { LogEntry } from "@opsremedy/core/types";
import type { GcpLoggingClient, GcpLogsQuery } from "../types.ts";

export interface FixtureGcpPayload {
  logs: LogEntry[];
}

/**
 * Serves log entries from a pre-loaded fixture file.
 * Matching is best-effort: supports `severity>=ERROR`, `severity>=WARNING`,
 * and substring checks against resource.labels.pod_name / resource.type.
 * Good enough for scenario testing.
 */
export class FixtureGcpLoggingClient implements GcpLoggingClient {
  constructor(private readonly data: FixtureGcpPayload) {}

  async search(q: GcpLogsQuery): Promise<LogEntry[]> {
    const filter = q.filter.toLowerCase();
    const fromMs = q.from.getTime();
    const toMs = q.to.getTime();

    const matches = this.data.logs.filter((entry) => {
      const ts = new Date(entry.timestamp).getTime();
      if (Number.isFinite(ts) && (ts < fromMs || ts > toMs)) return false;

      if (filter.includes("severity>=error") || filter.includes('severity="error"')) {
        if (!["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(entry.severity)) return false;
      }

      const podMatch = filter.match(/pod_name="([^"]+)"/);
      if (podMatch?.[1]) {
        const pod = podMatch[1].toLowerCase();
        const entryPod = (entry.resource?.pod_name ?? entry.labels?.pod_name ?? "").toLowerCase();
        if (!entryPod.includes(pod)) return false;
      }

      const nsMatch = filter.match(/namespace_name="([^"]+)"/);
      if (nsMatch?.[1]) {
        const ns = nsMatch[1].toLowerCase();
        const entryNs = (entry.resource?.namespace_name ?? entry.labels?.namespace_name ?? "").toLowerCase();
        if (!entryNs.includes(ns)) return false;
      }

      const containsMatch = filter.match(/textpayload:"([^"]+)"/);
      if (containsMatch?.[1]) {
        if (!entry.textPreview.toLowerCase().includes(containsMatch[1].toLowerCase())) return false;
      }

      return true;
    });

    return matches.slice(0, q.max);
  }

  /** Fixtures have no UI; tools must skip linkification when this returns undefined. */
  uiUrl(): undefined {
    return undefined;
  }
}
