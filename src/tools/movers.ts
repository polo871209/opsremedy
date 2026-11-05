import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { sreTool, type SreTool } from "./types.ts";
import { textResult, guarded } from "./result.ts";
import { promFetch } from "./prom.ts";

interface Mover {
  name: string;
  spike: number;
  baseline: number;
  ratio: number | "new";
}

function rankMovers(
  series: { name: string; samples: [number, number][] }[],
  spikeStartUnix: number,
  spikeEndUnix: number,
  minSpike: number,
): { movers: Mover[]; comparable: number } {
  const out: Mover[] = [];
  let comparable = 0;
  for (const s of series) {
    const inWin: number[] = [];
    const outWin: number[] = [];
    for (const [t, v] of s.samples) {
      if (!Number.isFinite(v)) continue;
      (t >= spikeStartUnix && t <= spikeEndUnix ? inWin : outWin).push(v);
    }
    if (!inWin.length || !outWin.length) continue;
    comparable++;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const spike = mean(inWin);
    const baseline = mean(outWin);
    if (spike <= 0 || spike < minSpike) continue;
    out.push({
      name: s.name,
      spike: Number(spike.toFixed(3)),
      baseline: Number(baseline.toFixed(3)),
      ratio: baseline > minSpike / 10 ? Number((spike / baseline).toFixed(2)) : "new",
    });
  }
  const ranked = out.sort((a, b) => {
    const ra = a.ratio === "new" ? Infinity : a.ratio;
    const rb = b.ratio === "new" ? Infinity : b.ratio;
    return rb - ra || b.spike - a.spike;
  });
  return { movers: ranked, comparable };
}

const FLEETS: Record<string, { expr: string; label: string; unit: string }> = {
  k8s: {
    expr: 'sum by (container_name)(rate({__name__="kubernetes.io/container/cpu/core_usage_time", monitored_resource="k8s_container"}[3m]))',
    label: "container_name",
    unit: "cores",
  },
  cloud_functions: {
    expr: 'sum by (function_name)(rate({__name__="cloudfunctions.googleapis.com/function/execution_times_sum", monitored_resource="cloud_function"}[3m])) / 1e9',
    label: "function_name",
    unit: "seconds of execution per second (= concurrent instances)",
  },
  cloud_run: {
    expr: 'sum by (service_name)(rate({__name__="run.googleapis.com/request_count", monitored_resource="cloud_run_revision"}[3m]))',
    label: "service_name",
    unit: "requests per second",
  },
};

export function moversTool(promUrl: string): SreTool {
  return sreTool({
    name: "promql_movers",
    cheap: false,
    retry: true,
    description:
      "Rank the workloads of one fleet by how much each rose in the spike window against the 30 min on each side. " +
      "Use it when the alerting metric names no caller (Firestore reads, Cloud SQL connections, egress), and before you rule out a fleet whose own counter is flat. " +
      "An empty movers_rose list is a result: that fleet did not move.",
    parameters: obj({
      fleet: oneOf(["k8s", "cloud_functions", "cloud_run", "custom"], {
        description: "Run k8s and cloud_functions before you rule out a caller. 'custom' needs `query`.",
      }),
      spikeStart: str({
        description: "ISO8601 or unix-ms/sec. The start of the spike, not of the alert window.",
      }),
      spikeEnd: str({ description: "ISO8601 or unix-ms/sec. End of the spike." }),
      query: opt(
        str({
          description:
            "fleet='custom' only. PromQL that aggregates to one label, for example sum by (pod)(rate(x[3m])). The label value names each mover.",
        }),
      ),
      limit: opt(int({ minimum: 1, maximum: 30, default: 10 })),
    }),
    execute: guarded(async (a, tw) => {
      const fleet = FLEETS[a.fleet];
      const expr = a.fleet === "custom" ? a.query : fleet?.expr;
      if (!expr) return textResult("fleet='custom' requires `query`.", true);
      const spike = tw.clamp({ startTime: a.spikeStart, endTime: a.spikeEnd });
      const padded = tw.clamp({
        startTime: String(spike.startUnix * 1000 - 30 * 60_000),
        endTime: String(spike.endUnix * 1000 + 30 * 60_000),
      });
      const params = new URLSearchParams({
        query: expr,
        start: String(padded.startUnix),
        end: String(padded.endUnix),
        step: "180",
      });
      const { ok, body } = await promFetch(promUrl, "/api/v1/query_range", params);
      if (!ok) return textResult(body, true);
      const result = (body as { data?: { result?: { metric: Record<string, string>; values: [number, string][] }[] } })
        .data?.result;
      if (!Array.isArray(result)) return textResult(body, true);
      const label = a.fleet === "custom" ? undefined : fleet!.label;
      const series = result.map((s) => ({
        name: (label ? s.metric[label] : Object.values(s.metric).find((v) => v)) ?? "(unlabelled)",
        samples: s.values.map(([t, v]) => [t, Number(v)] as [number, number]),
      }));
      const peak = Math.max(
        ...series.map((s) => {
          const inWin = s.samples
            .filter(([t, v]) => t >= spike.startUnix && t <= spike.endUnix && Number.isFinite(v))
            .map(([, v]) => v);
          return inWin.length ? Math.max(...inWin) : 0;
        }),
        0,
      );
      const ranked = rankMovers(series, spike.startUnix, spike.endUnix, peak * 0.05);
      const movers = ranked.movers.slice(0, a.limit ?? 10);
      const rose = movers.filter((m) => m.ratio === "new" || m.ratio >= 1.5);
      return textResult({
        fleet: a.fleet,
        unit: fleet?.unit,
        spike_window: { start: spike.startISO, end: spike.endISO },
        baseline_from: { start: padded.startISO, end: padded.endISO, excluding: "the spike window" },
        series_compared: ranked.comparable,
        series_returned: series.length,
        movers_rose: rose,
        movers_flat: movers.filter((m) => !rose.includes(m)),
        verdict:
          ranked.comparable === 0
            ? "INCONCLUSIVE: no series in this fleet has samples both inside and outside the spike window, so nothing was compared. Do NOT rule the fleet out. Widen the window or check that the fleet's metric exists before you move on."
            : rose.length
              ? "Candidates rose with the spike. Confirm one by reading its logs for the spike window before naming it."
              : "NOTHING in this fleet rose with the spike. Rule the whole fleet out and check the others; if every fleet is flat, the caller runs outside this project's compute and only Data Access audit logs can name it.",
      });
    }),
  });
}
