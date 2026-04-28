import { describe, expect, test } from "bun:test";
import { capList, jsonByteSize, truncate } from "./truncate.ts";

describe("truncate", () => {
  test("returns input unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("clips and adds ellipsis when over", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  test("falls back to hard cut when max is too small for suffix", () => {
    expect(truncate("abcdef", 1)).toBe("a");
  });

  test("custom suffix respected", () => {
    expect(truncate("abcdefghij", 6, "...")).toBe("abc...");
  });
});

describe("capList", () => {
  test("no overflow", () => {
    expect(capList([1, 2, 3], 5)).toEqual({ kept: [1, 2, 3], overflow: 0 });
  });

  test("overflow reports remainder count", () => {
    expect(capList([1, 2, 3, 4, 5], 2)).toEqual({ kept: [1, 2], overflow: 3 });
  });
});

describe("jsonByteSize", () => {
  test("counts utf8 bytes after JSON.stringify", () => {
    // {"a":"é"} → 10 bytes; é is 2 bytes in utf8.
    expect(jsonByteSize({ a: "é" })).toBe(10);
    expect(jsonByteSize({ a: "a" })).toBe(9);
  });
});
