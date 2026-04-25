import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioClients, setClients } from "@opsremedy/clients";
import {
  addUsage,
  diagnose,
  gatherEvidence,
  newContext,
  type RCAReport,
  validateAndFinalize,
} from "@opsremedy/core";
import { listScenarios, loadScenario, type Scenario } from "./load.ts";
import { type ScenarioScore, scoreScenario } from "./scoring.ts";

export interface BenchOptions {
  scenario?: string;
  asJson?: boolean;
  scenariosDir?: string;
}

export interface ScenarioRun {
  id: string;
  score: ScenarioScore;
  report: RCAReport;
  tools_called: string[];
}

export interface BenchResult {
  runs: ScenarioRun[];
  allPassed: boolean;
}

function defaultScenariosDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "scenarios");
}

async function runOne(scenario: Scenario): Promise<ScenarioRun> {
  setClients(loadScenarioClients(scenario.dir));
  const ctx = newContext(scenario.alert, scenario.answer.max_tool_calls);

  const provider = Bun.env.OPSREMEDY_LLM_PROVIDER ?? "anthropic";
  const model = Bun.env.OPSREMEDY_LLM_MODEL ?? "claude-sonnet-4-5-20250929";

  const gatherUsage = await gatherEvidence(ctx, { provider, model });
  const { report: raw, usage: diagnoseUsage } = await diagnose(ctx, { provider, model });

  const validated = validateAndFinalize(raw, ctx);
  const report: RCAReport = { ...validated, usage: addUsage(gatherUsage, diagnoseUsage) };
  const toolsCalled = ctx.tools_called.map((t) => t.name);
  const score = scoreScenario(report, ctx.evidence, toolsCalled, scenario.answer);

  return { id: scenario.id, score, report, tools_called: toolsCalled };
}

export async function runBench(options: BenchOptions = {}): Promise<BenchResult> {
  const scenariosDir = options.scenariosDir ?? defaultScenariosDir();
  let scenarios: Scenario[];
  if (options.scenario) {
    const path = resolve(scenariosDir, options.scenario);
    scenarios = [loadScenario(path)];
  } else {
    scenarios = listScenarios(scenariosDir);
  }

  if (scenarios.length === 0) {
    console.error(`No scenarios found in ${scenariosDir}`);
    return { runs: [], allPassed: false };
  }

  const runs: ScenarioRun[] = [];
  for (const scenario of scenarios) {
    const run = await runOne(scenario);
    runs.push(run);
    if (options.asJson) continue;
    printHuman(run);
  }

  const passed = runs.filter((r) => r.score.overall).length;
  const allPassed = passed === runs.length;
  if (options.asJson) {
    console.log(JSON.stringify({ runs, summary: { passed, total: runs.length } }, null, 2));
  } else {
    console.log(`\nSummary: ${passed}/${runs.length} scenarios passed`);
  }
  return { runs, allPassed };
}

function printHuman(run: ScenarioRun): void {
  const mark = run.score.overall ? "PASS" : "FAIL";
  console.log(
    `[${mark}] ${run.id} — category=${run.report.root_cause_category} confidence=${run.report.confidence}`,
  );
  if (!run.score.overall) {
    if (!run.score.category_ok) console.log(`  category mismatch`);
    if (run.score.missing_keywords.length > 0)
      console.log(`  missing keywords: ${run.score.missing_keywords.join(", ")}`);
    if (!run.score.not_forbidden) console.log(`  hit forbidden category/keywords`);
    if (run.score.missing_evidence.length > 0)
      console.log(`  missing evidence: ${run.score.missing_evidence.join(", ")}`);
    if (run.score.missing_trajectory.length > 0)
      console.log(`  missing tool calls: ${run.score.missing_trajectory.join(", ")}`);
    if (!run.score.loops_ok) console.log(`  exceeded max tool calls`);
  }
}
