import { Type } from "@earendil-works/pi-ai";
import type { SreTool } from "./types.ts";
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
  return {
    name: "promql_movers",
    cheap: false,
    retry: true,
    description:
      "Attribute a spike to a workload. Give it the spike window; it ranks every container, Cloud Function or Cloud Run service by how much it rose IN that window against the rest of the queried range, and returns the movers. " +
      "Reach for it whenever the alerting metric is GCP-level and names no caller (Firestore reads, Cloud SQL connections, egress) or when a per-service counter stays flat and you are about to rule that fleet out. " +
      "An EMPTY movers list is a real result, not a failure: no workload in that fleet moved, so the caller runs outside it (another fleet, or outside this project entirely — a laptop, Cloud Shell or external tool holding service-account credentials). Check the other fleets before concluding.",
    parameters: Type.Object({
      fleet: Type.Union(
        [Type.Literal("k8s"), Type.Literal("cloud_functions"), Type.Literal("cloud_run"), Type.Literal("custom")],
        {
          description:
            "Which fleet to rank. Run k8s and cloud_functions before ruling a caller out; 'custom' needs `query`.",
        },
      ),
      spikeStart: Type.String({
        description: "ISO8601 or unix-ms/sec. Start of the spike itself, not of the alert window.",
      }),
      spikeEnd: Type.String({ description: "ISO8601 or unix-ms/sec. End of the spike." }),
      query: Type.Optional(
        Type.String({
          description:
            "fleet='custom' only: a PromQL expression aggregating to ONE label, e.g. sum by (pod)(rate(x[3m])). The label value becomes the mover name.",
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 10 })),
    }),
    execute: guarded(async (args, tw) => {
      const a = args as { fleet: string; spikeStart: string; spikeEnd: string; query?: string; limit?: number };
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
  };
}
