import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import pc from "picocolors";

export type ThinkingPhase = "gather" | "diagnose";

export interface ThinkingStreamOptions {
  phase: ThinkingPhase;
  /** Forwarded as ("thinking_start"|"thinking_delta"|"thinking_end", detail). */
  onEvent?: (kind: string, detail?: unknown) => void;
  /** When false, suppress console output but still call onEvent. Default true. */
  display?: boolean;
  /** Output sink. Default process.stderr (keeps stdout clean for JSON). */
  stream?: NodeJS.WriteStream;
  /** Soft-wrap width. Default: stream.columns ?? 100. */
  width?: number;
}

const DEFAULT_WIDTH = 100;
const INDENT = "  ";

/**
 * Renders streaming `thinking_*` events from pi-ai as section blocks:
 *
 *   [thinking gather]
 *     I should check k8s events first because OOMKilled would surface
 *     there.
 *
 * One header per thinking block, indented body lines, blank line after end.
 * Buffers partial deltas, flushes on newline or width hit. Also forwards each
 * thinking event to onEvent so a TraceWriter can persist it as JSONL.
 */
export class ThinkingStream {
  private readonly buffers = new Map<number, string>();
  private readonly stream: NodeJS.WriteStream;
  private readonly width: number;
  private readonly display: boolean;

  constructor(private readonly opts: ThinkingStreamOptions) {
    this.stream = opts.stream ?? process.stderr;
    this.width = opts.width ?? this.stream.columns ?? DEFAULT_WIDTH;
    this.display = opts.display ?? true;
  }

  handleAssistantEvent(ev: AssistantMessageEvent): void {
    if (ev.type === "thinking_start") {
      this.buffers.set(ev.contentIndex, "");
      this.writeHeader();
      this.emit("thinking_start", { contentIndex: ev.contentIndex });
    } else if (ev.type === "thinking_delta") {
      this.append(ev.contentIndex, ev.delta);
      this.emit("thinking_delta", { contentIndex: ev.contentIndex, delta: ev.delta });
    } else if (ev.type === "thinking_end") {
      this.flush(ev.contentIndex);
      this.writeBlank();
      this.emit("thinking_end", { contentIndex: ev.contentIndex });
    }
  }

  private append(idx: number, delta: string): void {
    let buf = (this.buffers.get(idx) ?? "") + delta;
    // 1. Emit complete newline-terminated lines.
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) this.writeBody(line);
    // 2. Soft-wrap when buffer outgrows width.
    const max = this.maxBodyLen();
    while (buf.length >= max) {
      const breakAt = lastSpaceBefore(buf, max);
      this.writeBody(buf.slice(0, breakAt).trimEnd());
      buf = buf.slice(breakAt).trimStart();
    }
    this.buffers.set(idx, buf);
  }

  private flush(idx: number): void {
    const buf = this.buffers.get(idx);
    if (buf && buf.length > 0) this.writeBody(buf);
    this.buffers.delete(idx);
  }

  private maxBodyLen(): number {
    return Math.max(20, this.width - INDENT.length);
  }

  private writeHeader(): void {
    if (!this.display) return;
    this.stream.write(`${pc.dim(`[thinking ${this.opts.phase}]`)}\n`);
  }

  private writeBody(text: string): void {
    if (!this.display) return;
    // Skip blank lines that would just create extra whitespace inside the block.
    if (text.length === 0) return;
    this.stream.write(`${pc.dim(pc.italic(INDENT + text))}\n`);
  }

  private writeBlank(): void {
    if (!this.display) return;
    this.stream.write("\n");
  }

  private emit(kind: string, detail: Record<string, unknown>): void {
    this.opts.onEvent?.(kind, { phase: this.opts.phase, ...detail });
  }
}

function lastSpaceBefore(s: string, max: number): number {
  // Prefer breaking at the last space within [0, max). Fall back to hard split.
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > 0 ? lastSpace : max;
}
