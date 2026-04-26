import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioClients, resetClients, setClients } from "@opsremedy/clients";
import { executePipeline, newContext, type RCAReport } from "@opsremedy/core";
import type { AuditEntry } from "@opsremedy/core/types";
import { listScenarios, loadScenario, type Scenario } from "./load.ts";
import { type ScenarioScore, scoreScenario } from "./scoring.ts";

export interface BenchOptions {
  scenario?: string;
  asJson?: boolean;
  scenariosDir?: string;
  provider?: string;
  model?: string;
  displayThinking?: boolean;
}

export interface ScenarioRun {
  id: string;
  score: ScenarioScore;
  report: RCAReport;
  tools_called: string[];
  audit: AuditEntry[];
}

export interface BenchResult {
  runs: ScenarioRun[];
  allPassed: boolean;
}

function defaultScenariosDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "scenarios");
}

async function runOne(
  scenario: Scenario,
  provider: string,
  model: string,
  displayThinking: boolean,
): Promise<ScenarioRun> {
  // Reset first so a previous scenario's fixtures can't leak into this run
  // when the new one omits a client (registry uses Object.assign-style merge).
  resetClients();
  setClients(loadScenarioClients(scenario.dir));

  const ctx = newContext(scenario.alert, scenario.answer.max_tool_calls);
  const report = await executePipeline(ctx, { provider, model, displayThinking });

  const toolsCalled = ctx.tools_called.map((t) => t.name);
  const score = scoreScenario(report, ctx.evidence, toolsCalled, scenario.answer);

  return { id: scenario.id, score, report, tools_called: toolsCalled, audit: ctx.audit };
}

export async function runBench(options: BenchOptions = {}): Promise<BenchResult> {
  const scenariosDir = options.scenariosDir ?? defaultScenariosDir();
  const provider = options.provider ?? Bun.env.OPSREMEDY_LLM_PROVIDER ?? "anthropic";
  const model = options.model ?? Bun.env.OPSREMEDY_LLM_MODEL ?? "claude-sonnet-4-5-20250929";
  const displayThinking = options.displayThinking ?? !options.asJson;

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
    const run = await runOne(scenario, provider, model, displayThinking);
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
