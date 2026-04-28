import type { RootCauseCategory } from "@opsremedy/core/types";
import type { CardTemplate } from "../types.ts";

/** Header color signals triage urgency. Red = needs human, green = healthy. */
const TEMPLATE_BY_CATEGORY: Record<RootCauseCategory, CardTemplate> = {
  resource_exhaustion: "red",
  dependency: "red",
  deployment: "red",
  configuration: "carmine",
  infrastructure: "orange",
  data_quality: "yellow",
  unknown: "grey",
  healthy: "green",
};

export function colorFor(category: RootCauseCategory): CardTemplate {
  return TEMPLATE_BY_CATEGORY[category] ?? "grey";
}
