import { describe, expect, test } from "bun:test";
import { addUsage, sumUsage, ZERO_USAGE } from "./usage.ts";

describe("sumUsage", () => {
  test("returns zero usage on empty", () => {
    expect(sumUsage([])).toEqual(ZERO_USAGE);
  });

  test("ignores non-assistant messages", () => {
    const out = sumUsage([
      { role: "user", usage: { input: 100 } },
      { role: "system", usage: { input: 50 } },
    ]);
    expect(out.input_tokens).toBe(0);
  });

  test("ignores assistant messages without usage", () => {
    const out = sumUsage([{ role: "assistant" }]);
    expect(out.total_tokens).toBe(0);
  });

  test("sums fields across multiple assistant messages", () => {
    const out = sumUsage([
      { role: "assistant", usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } } },
      { role: "assistant", usage: { input: 5, output: 15, totalTokens: 20, cost: { total: 0.002 } } },
    ]);
    expect(out.input_tokens).toBe(15);
    expect(out.output_tokens).toBe(35);
    expect(out.total_tokens).toBe(50);
    expect(out.cost_usd).toBe(0.003);
  });

  test("rounds cost to 6 decimals", () => {
    const out = sumUsage([
      { role: "assistant", usage: { cost: { total: 0.0000001 } } },
      { role: "assistant", usage: { cost: { total: 0.0000002 } } },
    ]);
    // 0.0000003 rounds to 0 at 6 decimals
    expect(out.cost_usd).toBe(0);
  });

  test("treats missing fields as zero", () => {
    const out = sumUsage([{ role: "assistant", usage: {} }]);
    expect(out).toEqual(ZERO_USAGE);
  });

  test("counts cache fields", () => {
    const out = sumUsage([{ role: "assistant", usage: { cacheRead: 100, cacheWrite: 50 } }]);
    expect(out.cache_read_tokens).toBe(100);
    expect(out.cache_write_tokens).toBe(50);
  });
});

describe("addUsage", () => {
  test("is commutative", () => {
    const a = { ...ZERO_USAGE, input_tokens: 10, cost_usd: 0.001 };
    const b = { ...ZERO_USAGE, output_tokens: 20, cost_usd: 0.002 };
    expect(addUsage(a, b)).toEqual(addUsage(b, a));
  });

  test("identity with ZERO_USAGE", () => {
    const a = { ...ZERO_USAGE, input_tokens: 5, output_tokens: 5, total_tokens: 10, cost_usd: 0.001 };
    expect(addUsage(a, ZERO_USAGE)).toEqual(a);
  });

  test("rounds cost to 6 decimals", () => {
    const a = { ...ZERO_USAGE, cost_usd: 0.1234567 };
    const b = { ...ZERO_USAGE, cost_usd: 0.0000001 };
    expect(addUsage(a, b).cost_usd).toBe(0.123457);
  });
});
