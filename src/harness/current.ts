import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";

export const ctx = BACKGROUND_CONTEXT;

let current: Harness | undefined;

export function setHarness(h: Harness | undefined): void {
  current = h;
}

export function harness(): Harness {
  if (!current) throw new Error("harness not open");
  return current;
}
