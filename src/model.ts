import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "./config.ts";
import { getAnthropicToken } from "./utils/anthropic_token.ts";

// The OAuth token rotates in-process (utils/token-refresh.ts), so the Anthropic provider reads it at each request
// instead of from the boot environment. ANTHROPIC_AUTH_TOKEN would win over it as a bearer header, so it stays hidden.
export const models = builtinModels({
  authContext: {
    async env(name) {
      if (name === "ANTHROPIC_OAUTH_TOKEN") return getAnthropicToken();
      if (name === "ANTHROPIC_AUTH_TOKEN") return undefined;
      return process.env[name]?.trim() || undefined;
    },
    async fileExists(path) {
      try {
        await access(path.startsWith("~") ? homedir() + path.slice(1) : path);
        return true;
      } catch {
        return false;
      }
    },
  },
});

export function buildModel(cfg: Config, name: string) {
  const model = models.getModel(cfg.model.provider, name);
  if (!model) throw new Error(`unknown model: ${cfg.model.provider}/${name}`);
  return model;
}

export const completeSimple = models.completeSimple.bind(models);
