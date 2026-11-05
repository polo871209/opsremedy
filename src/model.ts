import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "./config.ts";
import { anthropicCredentials } from "./utils/token-refresh.ts";

export const models = builtinModels({ credentials: anthropicCredentials });

export function buildModel(cfg: Config, name: string) {
  const model = models.getModel(cfg.model.provider, name);
  if (!model) throw new Error(`unknown model: ${cfg.model.provider}/${name}`);
  return model;
}

export const completeSimple = models.completeSimple.bind(models);
