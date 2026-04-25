import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL trace writer. One event per line.
 * Used by the CLI when `--trace <path>` is set so investigations are replayable.
 */
export class TraceWriter {
  private fd: number;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }

  write(kind: string, detail?: unknown): void {
    if (this.closed) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), kind, detail })}\n`;
    writeSync(this.fd, line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      // best-effort
    }
  }
}
