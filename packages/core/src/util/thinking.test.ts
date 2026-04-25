import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { ThinkingStream } from "./thinking.ts";

const PARTIAL = {} as AssistantMessage;

function delta(contentIndex: number, text: string): AssistantMessageEvent {
  return { type: "thinking_delta", contentIndex, delta: text, partial: PARTIAL };
}

function start(contentIndex: number): AssistantMessageEvent {
  return { type: "thinking_start", contentIndex, partial: PARTIAL };
}

function end(contentIndex: number, content = ""): AssistantMessageEvent {
  return { type: "thinking_end", contentIndex, content, partial: PARTIAL };
}

class FakeStream {
  written: string[] = [];
  columns = 100;
  isTTY = true;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI codes
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("ThinkingStream", () => {
  test("emits header on start, indented body, blank on end", () => {
    const fake = new FakeStream();
    const events: Array<{ kind: string; detail: unknown }> = [];
    const ts = new ThinkingStream({
      phase: "gather",
      stream: fake as unknown as NodeJS.WriteStream,
      onEvent: (kind, detail) => events.push({ kind, detail }),
    });

    ts.handleAssistantEvent(start(0));
    ts.handleAssistantEvent(delta(0, "hello "));
    ts.handleAssistantEvent(delta(0, "world\nsecond line"));
    ts.handleAssistantEvent(end(0));

    const lines = fake.written.map(stripAnsi);
    expect(lines).toEqual(["[thinking gather]\n", "  hello world\n", "  second line\n", "\n"]);
    expect(events.map((e) => e.kind)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
    ]);
  });

  test("soft-wraps long lines at word boundary near width", () => {
    const fake = new FakeStream();
    const ts = new ThinkingStream({
      phase: "gather",
      stream: fake as unknown as NodeJS.WriteStream,
      width: 40,
    });
    ts.handleAssistantEvent(start(0));
    ts.handleAssistantEvent(
      delta(0, "this is a fairly long thinking line that should wrap at a word boundary"),
    );
    ts.handleAssistantEvent(end(0));

    const bodyLines = fake.written
      .map(stripAnsi)
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim());
    expect(bodyLines.length).toBeGreaterThan(1);
    const joined = bodyLines.join(" ");
    expect(joined).toContain("fairly long thinking line");
  });

  test("display=false suppresses output but still emits onEvent", () => {
    const fake = new FakeStream();
    const events: string[] = [];
    const ts = new ThinkingStream({
      phase: "diagnose",
      stream: fake as unknown as NodeJS.WriteStream,
      display: false,
      onEvent: (kind) => events.push(kind),
    });
    ts.handleAssistantEvent(start(0));
    ts.handleAssistantEvent(delta(0, "secret thoughts\n"));
    ts.handleAssistantEvent(end(0));

    expect(fake.written.length).toBe(0);
    expect(events).toEqual(["thinking_start", "thinking_delta", "thinking_end"]);
  });

  test("flushes remaining buffer on thinking_end", () => {
    const fake = new FakeStream();
    const ts = new ThinkingStream({ phase: "gather", stream: fake as unknown as NodeJS.WriteStream });
    ts.handleAssistantEvent(start(0));
    ts.handleAssistantEvent(delta(0, "no trailing newline"));
    ts.handleAssistantEvent(end(0));
    expect(fake.written.map(stripAnsi)).toEqual(["[thinking gather]\n", "  no trailing newline\n", "\n"]);
  });

  test("phase tag included in onEvent details", () => {
    const fake = new FakeStream();
    const events: Array<{ kind: string; detail: unknown }> = [];
    const ts = new ThinkingStream({
      phase: "diagnose",
      stream: fake as unknown as NodeJS.WriteStream,
      onEvent: (kind, detail) => events.push({ kind, detail }),
    });
    ts.handleAssistantEvent(start(2));
    ts.handleAssistantEvent(delta(2, "x\n"));
    ts.handleAssistantEvent(end(2));

    expect(events[0]?.detail).toEqual({ phase: "diagnose", contentIndex: 2 });
    expect(events[1]?.detail).toEqual({ phase: "diagnose", contentIndex: 2, delta: "x\n" });
  });

  test("ignores non-thinking events", () => {
    const fake = new FakeStream();
    const ts = new ThinkingStream({ phase: "gather", stream: fake as unknown as NodeJS.WriteStream });
    ts.handleAssistantEvent({
      type: "text_delta",
      contentIndex: 0,
      delta: "ignored",
      partial: PARTIAL,
    } as AssistantMessageEvent);
    expect(fake.written.length).toBe(0);
  });

  test("collapses internal blank lines (no double blanks inside block)", () => {
    const fake = new FakeStream();
    const ts = new ThinkingStream({ phase: "gather", stream: fake as unknown as NodeJS.WriteStream });
    ts.handleAssistantEvent(start(0));
    ts.handleAssistantEvent(delta(0, "first\n\nsecond\n"));
    ts.handleAssistantEvent(end(0));
    const lines = fake.written.map(stripAnsi);
    expect(lines).toEqual(["[thinking gather]\n", "  first\n", "  second\n", "\n"]);
  });
});
