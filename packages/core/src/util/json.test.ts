import { describe, expect, test } from "bun:test";
import { extractJsonObject, safeParse } from "./json.ts";

describe("extractJsonObject", () => {
  test("returns trimmed input when whole text is valid JSON", () => {
    const out = extractJsonObject('  {"a": 1}  ');
    expect(out).toBe('{"a": 1}');
  });

  test("strips ```json fence", () => {
    const out = extractJsonObject('```json\n{"a": 1}\n```');
    expect(out).toBe('{"a": 1}');
  });

  test("strips bare ``` fence", () => {
    const out = extractJsonObject('```\n{"a": 1}\n```');
    expect(out).toBe('{"a": 1}');
  });

  test("returns first parseable fence when multiple present", () => {
    const out = extractJsonObject('text\n```\nnot json\n```\n```\n{"a": 1}\n```');
    expect(out).toBe('{"a": 1}');
  });

  test("extracts balanced braces from prose-wrapped JSON", () => {
    const out = extractJsonObject('Here is the result: {"a": 1, "b": [1,2]} thanks!');
    expect(out).toBe('{"a": 1, "b": [1,2]}');
  });

  test("handles braces inside strings without misbalancing", () => {
    const out = extractJsonObject('{"msg": "we have { and } here", "n": 1}');
    expect(out).toBe('{"msg": "we have { and } here", "n": 1}');
  });

  test("handles escaped quotes", () => {
    const out = extractJsonObject('{"msg": "she said \\"hi\\"", "n": 2}');
    expect(out).toBe('{"msg": "she said \\"hi\\"", "n": 2}');
  });

  test("returns null when no opening brace", () => {
    expect(extractJsonObject("plain text only")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("   ")).toBeNull();
  });

  test("returns null when balanced extraction yields invalid JSON", () => {
    expect(extractJsonObject("{not real json}")).toBeNull();
  });

  test("returns null on unbalanced braces", () => {
    expect(extractJsonObject('{"a": 1')).toBeNull();
  });
});

describe("safeParse", () => {
  test("parses valid JSON", () => {
    const out = safeParse<{ a: number }>('{"a": 1}');
    expect(out).toEqual({ a: 1 });
  });

  test("returns null on invalid JSON", () => {
    expect(safeParse("nope")).toBeNull();
    expect(safeParse("")).toBeNull();
  });
});
