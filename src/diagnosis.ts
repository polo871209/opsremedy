import { arr, obj, oneOf, str, type Static } from "@earendil-works/pi-schema";

const RootCauseCategory = oneOf([
  "infrastructure",
  "application",
  "configuration",
  "dependency",
  "data",
  "network",
  "healthy",
  "unknown",
]);

export const DiagnosisSchema = obj({
  rootCause: str({ description: "1-2 sentences naming the mechanism. No preamble, no filler." }),
  rootCauseCategory: RootCauseCategory,
  confidence: oneOf(["high", "medium", "low"], {
    description:
      "high = mechanism proven by triangulated signals (metrics + logs/traces agreeing). medium = plausible on partial evidence. low = thin or inconclusive, pair with category=unknown.",
  }),
  evidence: arr(str(), {
    maxItems: 4,
    description:
      "≤100 chars per bullet, format '<tool/signal>: <fact>'. No full sentences, no restating rootCause, no timestamps unless the timing IS the fact.",
  }),
  remediationSteps: arr(str(), {
    maxItems: 4,
    description:
      "Short actionable steps (rollback, scale, config fix, escalate), each naming its target. Empty array when healthy or nothing is warranted.",
  }),
});

export type Diagnosis = Static<typeof DiagnosisSchema>;
