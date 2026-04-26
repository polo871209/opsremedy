import { describe, expect, test } from "bun:test";
import { intentWindowMinutes } from "./shared.ts";

describe("intentWindowMinutes", () => {
  test("maps each literal to its minute count", () => {
    expect(intentWindowMinutes("5m")).toBe(5);
    expect(intentWindowMinutes("15m")).toBe(15);
    expect(intentWindowMinutes("1h")).toBe(60);
    expect(intentWindowMinutes("6h")).toBe(360);
    expect(intentWindowMinutes("24h")).toBe(1440);
  });

  test("undefined input returns undefined (caller falls back)", () => {
    expect(intentWindowMinutes(undefined)).toBeUndefined();
  });
});
