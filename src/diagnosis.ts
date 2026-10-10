import { Type, type Static } from "@earendil-works/pi-ai";

const RootCauseCategory = Type.Union([
  Type.Literal("infrastructure"),
  Type.Literal("application"),
  Type.Literal("configuration"),
  Type.Literal("dependency"),
  Type.Literal("data"),
  Type.Literal("network"),
  Type.Literal("healthy"),
  Type.Literal("unknown"),
]);

export const DiagnosisSchema = Type.Object({
  rootCause: Type.String({ description: "1-2 sentences naming the mechanism. No preamble, no filler." }),
  rootCauseCategory: RootCauseCategory,
  confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
    description:
      "high = mechanism proven by triangulated signals (metrics + logs/traces agreeing). medium = plausible on partial evidence. low = thin or inconclusive, pair with category=unknown.",
  }),
  evidence: Type.Array(Type.String(), {
    maxItems: 4,
    description:
      "≤100 chars per bullet, format '<tool/signal>: <fact>'. No full sentences, no restating rootCause, no timestamps unless the timing IS the fact.",
  }),
  remediationSteps: Type.Array(Type.String(), {
    maxItems: 4,
    description:
      "Short actionable steps (rollback, scale, config fix, escalate), each naming its target. Empty array when healthy or nothing is warranted.",
  }),
});

export type Diagnosis = Static<typeof DiagnosisSchema>;
