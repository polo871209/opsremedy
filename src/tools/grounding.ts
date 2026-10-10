import { log } from "../utils/logger.ts";
import { classifyBool, jevAvailable } from "../utils/typesafe.ts";

const CRITERIA = {
  true: "A number, error string, identifier, or log line in the state backs the claim. A fair reading of the state supports it.",
  false:
    "The state contains nothing that backs the claim. The claim names a cause, a count, or a mechanism the state never shows.",
};

export async function ungroundedClaims(claims: string[], corpus: string): Promise<number[]> {
  if (!jevAvailable() || claims.length === 0 || !corpus) return [];
  const questions = Object.fromEntries(
    claims.map((claim, i) => [
      `claim_${i}`,
      {
        instructions: `The state is raw tool output from an SRE investigation. The claim below is supported by that output.\nClaim: ${claim}`,
        criteria: CRITERIA,
      },
    ]),
  );
  try {
    // Jev holds 32k tokens of state, so it reads the tail, where the conclusive tool results sit.
    const answers = await classifyBool({ tool_output: corpus.slice(-60_000) }, questions, 5_000);
    const failed: number[] = [];
    for (const [i] of claims.entries()) {
      const value = answers[`claim_${i}`];
      if (typeof value === "number" && value <= 0.3) failed.push(i);
    }
    log.info("grounding check", { claims: claims.length, rejected: failed.length });
    return failed;
  } catch (e) {
    log.warn("grounding check failed; diagnosis passes on the token check alone", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
