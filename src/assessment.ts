import { arr, bool, obj, str, type Static } from "@earendil-works/pi-schema";

export const AssessmentSchema = obj({
  actionRequired: bool({
    description:
      "true when a production part contains the affected component and is not proven fixed or unreachable, or when its version is a gap.",
  }),
  summary: str({ description: "At most 2 sentences. What is affected and why, or why production is not affected." }),
  affected: arr(str(), {
    maxItems: 6,
    description: "'<part>: <version>, <why it matches>'. Empty when actionRequired is false.",
  }),
  evidence: arr(str(), {
    maxItems: 6,
    description: "≤120 chars per bullet, format '<tool>: <fact>'.",
  }),
  actions: arr(str(), {
    maxItems: 5,
    description: "Concrete steps that name their target. Empty when actionRequired is false.",
  }),
});

export type Assessment = Static<typeof AssessmentSchema>;
