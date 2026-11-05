import { dirname, join } from "node:path";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Config } from "../config.ts";
import { models } from "../model.ts";
import { resolveTools } from "../tools/registry.ts";
import { log } from "../utils/logger.ts";
import { ctx, harness, setHarness } from "./current.ts";
import { DeployWatchTask } from "../deploy/watch.ts";
import { ThreatAssessmentTask } from "../feed/assess.ts";
import { InvestigationTask } from "./investigation.ts";
import { ReplyTask } from "./reply.ts";
import { pruneIdleThreads, type PruneResult } from "./retention.ts";
import { durableTool, submitAssessmentTool, submitDiagnosisTool } from "./tools.ts";

function harnessFilePath(dbPath: string): string {
  return join(dirname(dbPath), "harness.sqlite");
}

let database: SqliteDatabase | undefined;

export async function openHarness(cfg: Config): Promise<Harness> {
  database = cfg.session.dbPath ? await openNodeSqliteDatabase(harnessFilePath(cfg.session.dbPath)) : undefined;
  const storage = database ? await SqliteStorage.open(database) : new MemoryStorage();
  const tools = resolveTools(cfg);
  const cheap = new Set(tools.filter((t) => t.cheap).map((t) => t.name));
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "sre",
      tools: [...tools.map((t) => durableTool(t, cheap)), submitDiagnosisTool, submitAssessmentTool],
      tasks: [InvestigationTask, ReplyTask, DeployWatchTask, ThreatAssessmentTask],
      hooks: [
        hook(GenerationTask, {
          afterResponse: (message, api) => {
            log.info("turn end", {
              component: "agent",
              conversation: api.conversationId,
              stopReason: message.stopReason,
              modelMs: message.durationMs,
              thinkingLevel: message.thinkingLevel,
            });
          },
        }),
      ],
    }),
  );
  const h = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { toolExecution: cfg.agent.toolExecution, steeringMode: "all", afterFailedRun: "withdraw" },
      onReport: ({ kind, error }) => log.warn("harness report", { kind, error: String(error) }),
    },
    ctx,
  );
  setHarness(h);
  h.resume();
  log.info("harness open", { storage: cfg.session.dbPath ? harnessFilePath(cfg.session.dbPath) : "memory" });
  return h;
}

export async function pruneHarness(idleBefore: number): Promise<PruneResult | undefined> {
  return database && pruneIdleThreads(database, idleBefore);
}

export async function closeHarness(): Promise<void> {
  const h = harness();
  setHarness(undefined);
  database = undefined;
  await h.close(ctx);
}
