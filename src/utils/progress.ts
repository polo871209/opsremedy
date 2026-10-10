import { patchCard } from "../lark/client.ts";
import { track } from "./inflight.ts";
import { log } from "./logger.ts";

export interface ProgressReporter {
  update(status: string): void;
  finalize(card: unknown): Promise<void>;
}

const INTERVAL_MS = 3000;

export function makeProgressReporter(messageId: string, buildCard: (status: string) => unknown): ProgressReporter {
  let lastStatus = "";
  let lastPatchAt = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let finalized = false;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn, fn);
    return chain;
  };

  const flush = () => {
    pending = undefined;
    return enqueue(async () => {
      if (finalized) return;
      lastPatchAt = Date.now();
      try {
        await patchCard(messageId, buildCard(lastStatus));
      } catch (e) {
        log.warn("progress patch failed", { messageId, error: String(e) });
      }
    });
  };

  return {
    update(status: string) {
      if (finalized || !status || status === lastStatus) return;
      lastStatus = status;
      const since = Date.now() - lastPatchAt;
      if (since >= INTERVAL_MS) {
        if (pending) {
          clearTimeout(pending);
          pending = undefined;
        }
        track(flush());
      } else if (!pending) {
        pending = setTimeout(() => track(flush()), INTERVAL_MS - since);
        pending.unref?.();
      }
    },
    async finalize(card: unknown) {
      finalized = true;
      if (pending) {
        clearTimeout(pending);
        pending = undefined;
      }
      await enqueue(() => patchCard(messageId, card));
    },
  };
}
