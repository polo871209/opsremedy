import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Alert, RootCauseCategory } from "@opsremedy/core/types";
import { parse as parseYaml } from "yaml";

export interface ScenarioAnswer {
  scenario_id: string;
  difficulty: number;
  expected_category: RootCauseCategory;
  required_keywords: string[];
  forbidden_categories?: RootCauseCategory[];
  forbidden_keywords?: string[];
  required_evidence_sources: string[];
  optimal_trajectory?: string[];
  max_tool_calls: number;
}

export interface Scenario {
  id: string;
  dir: string;
  alert: Alert;
  answer: ScenarioAnswer;
}

export function loadScenario(dir: string): Scenario {
  const alertPath = join(dir, "alert.json");
  const answerPath = join(dir, "answer.yml");
  const alert = JSON.parse(readFileSync(alertPath, "utf8")) as Alert;
  const answer = parseYaml(readFileSync(answerPath, "utf8")) as ScenarioAnswer;
  return {
    id: answer.scenario_id,
    dir,
    alert,
    answer,
  };
}

export function listScenarios(rootDir: string): Scenario[] {
  const entries = readdirSync(rootDir);
  const scenarios: Scenario[] = [];
  for (const entry of entries) {
    const full = join(rootDir, entry);
    if (!statSync(full).isDirectory()) continue;
    try {
      scenarios.push(loadScenario(full));
    } catch {
      // skip non-scenario folders
    }
  }
  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}
