import type { ClassifierContext } from "@earendil-works/pi-ai";
import { models } from "../model.ts";
import { log } from "./logger.ts";

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly rejectedKey: boolean,
  ) {
    super(message);
  }
}

const jev = models.getModelOfType("classifier", "typesafe", "jev-latest");

export function jevAvailable(): boolean {
  return jev !== undefined && Boolean(process.env.TYPESAFE_API_KEY);
}

if (!jevAvailable()) log.warn("TypeSafe Jev unavailable; System One checks are off", { model: jev?.id ?? "missing" });

export async function classifyBool(
  state: ClassifierContext["state"],
  questions: Record<string, { instructions: string; criteria: { true: string; false: string } }>,
  timeoutMs: number,
): Promise<Record<string, number>> {
  if (!jev) throw new ClassifierError("typesafe/jev-latest is not in the pi-ai catalog", false);
  const result = await models.classify(
    jev,
    {
      state,
      questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: "bool" as const, ...q }])),
    },
    { timeoutMs, maxRetries: 1 },
  );
  if (result.stopReason !== "stop") {
    const message = result.errorMessage ?? result.stopReason;
    throw new ClassifierError(message, /\b40[13]\b/.test(message));
  }
  const out: Record<string, number> = {};
  for (const [id, answer] of Object.entries(result.answers)) if (answer.type === "bool") out[id] = answer.probability;
  return out;
}
