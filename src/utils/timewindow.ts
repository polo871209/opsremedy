import type { Alert } from "../alert.ts";

export interface TimeWindow {
  startMs: () => number;
  endMs: () => number;
  startISO: () => string;
  endISO: () => string;
  startUnix: () => number;
  endUnix: () => number;
  isOpen: boolean;
  clamp: (args?: { startTime?: string; endTime?: string }) => ClampedWindow;
}

interface ClampedWindow {
  startMs: number;
  endMs: number;
  startISO: string;
  endISO: string;
  startUnix: number;
  endUnix: number;
}

function parseFlexible(v: string): number | undefined {
  const ms = Date.parse(v);
  if (!Number.isNaN(ms)) return ms;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

export function makeTimeWindow(alert: Alert): TimeWindow {
  const startedMs = alert.startedAt ? Date.parse(alert.startedAt) : Date.now();
  const startMs = startedMs - 30 * 60 * 1000;
  const endedMs = alert.endedAt ? Date.parse(alert.endedAt) : undefined;
  const endMs = () => endedMs ?? Date.now();
  const clamp = (args?: { startTime?: string; endTime?: string }): ClampedWindow => {
    const outerStart = startMs;
    const outerEnd = endMs();
    let s = outerStart;
    let e = outerEnd;
    if (args?.startTime) {
      const v = parseFlexible(args.startTime);
      if (v !== undefined) s = Math.max(outerStart, Math.min(v, outerEnd));
    }
    if (args?.endTime) {
      const v = parseFlexible(args.endTime);
      if (v !== undefined) e = Math.max(outerStart, Math.min(v, outerEnd));
    }
    if (s >= e) s = Math.max(outerStart, e - 60_000);
    return {
      startMs: s,
      endMs: e,
      startISO: new Date(s).toISOString(),
      endISO: new Date(e).toISOString(),
      startUnix: Math.floor(s / 1000),
      endUnix: Math.floor(e / 1000),
    };
  };
  return {
    startMs: () => startMs,
    endMs,
    startISO: () => new Date(startMs).toISOString(),
    endISO: () => new Date(endMs()).toISOString(),
    startUnix: () => Math.floor(startMs / 1000),
    endUnix: () => Math.floor(endMs() / 1000),
    isOpen: endedMs === undefined,
    clamp,
  };
}
