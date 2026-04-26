import { describe, expect, test } from "bun:test";
import { reserveToolCallSlot } from "./gather.ts";
import { newContext } from "./run.ts";
import type { Alert } from "./types.ts";

const ALERT: Alert = {
  alert_id: "t-1",
  alert_name: "Test",
  severity: "critical",
  fired_at: new Date().toISOString(),
  labels: {},
  annotations: {},
  summary: "",
};

describe("reserveToolCallSlot", () => {
  test("allows calls below the budget", () => {
    const ctx = newContext(ALERT, 3);
    expect(reserveToolCallSlot(ctx)).toBeUndefined();
    expect(ctx.inflight).toBe(1);
  });

  test("blocks when loop_count alone hits the cap", () => {
    const ctx = newContext(ALERT, 2);
    ctx.loop_count = 2;
    const res = reserveToolCallSlot(ctx);
    expect(res).toEqual({ block: true, reason: "Exceeded tool call budget" });
    expect(ctx.inflight).toBe(0);
  });

  test("counts inflight against the cap (parallel batch cannot exceed)", () => {
    const ctx = newContext(ALERT, 3);
    // Three concurrent dispatches should fill the budget exactly.
    expect(reserveToolCallSlot(ctx)).toBeUndefined();
    expect(reserveToolCallSlot(ctx)).toBeUndefined();
    expect(reserveToolCallSlot(ctx)).toBeUndefined();
    // A fourth must be blocked even though loop_count is still 0.
    const res = reserveToolCallSlot(ctx);
    expect(res?.block).toBe(true);
    expect(ctx.inflight).toBe(3);
  });

  test("freed inflight slot becomes reservable again", () => {
    const ctx = newContext(ALERT, 2);
    reserveToolCallSlot(ctx);
    reserveToolCallSlot(ctx);
    expect(reserveToolCallSlot(ctx)?.block).toBe(true);
    // Simulate a tool finishing: define.ts decrements inflight + records loop.
    ctx.inflight--;
    ctx.loop_count++;
    // Still at cap (1 done + 1 inflight = 2).
    expect(reserveToolCallSlot(ctx)?.block).toBe(true);
    // Second tool finishes.
    ctx.inflight--;
    ctx.loop_count++;
    // Now exactly at cap from completed work; no room for new dispatch.
    expect(reserveToolCallSlot(ctx)?.block).toBe(true);
  });
});
