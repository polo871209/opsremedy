import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type EntryId,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type { Alert } from "../alert.ts";
import type { Diagnosis } from "../diagnosis.ts";

export type HandoffDoc = {
  markdown: string;
  messageCount: number;
  model: string;
  compiledAt: number;
  partial?: boolean;
  focus?: string;
};

export const ThreadIndex = defineDocFamily<{ conversationId: ConversationId | null }, null>({
  kind: "sre.thread-index",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ conversationId: null }),
});

export const AlertDoc = defineDoc<{ alert: JsonObject }>({
  kind: "sre.alert",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ alert: { name: "", source: "", severity: "" } }),
});

export type ThreadState = {
  threadKey: string;
  createdAt: number;
  investigating: boolean;
  side: ConversationId | null;
  handoff: JsonObject | null;
  budget: number | null;
  maintainer: boolean;
  diagnosis: JsonObject | null;
  groundingRejected: boolean;
  posted: EntryId[];
};

export const ThreadDoc = defineDoc<ThreadState>({
  kind: "sre.thread",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    threadKey: "",
    createdAt: 0,
    investigating: false,
    side: null,
    handoff: null,
    budget: null,
    maintainer: false,
    diagnosis: null,
    groundingRejected: false,
    posted: [],
  }),
});

export function json(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function alertOf(doc: { readonly alert: Readonly<JsonObject> } | undefined): Alert | undefined {
  return doc?.alert as Alert | undefined;
}

export function diagnosisOf(thread: ThreadState | undefined): Diagnosis | undefined {
  return (thread?.diagnosis ?? undefined) as Diagnosis | undefined;
}

export function handoffOf(thread: ThreadState | undefined): HandoffDoc | undefined {
  return (thread?.handoff ?? undefined) as HandoffDoc | undefined;
}
