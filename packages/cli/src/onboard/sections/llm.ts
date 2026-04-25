import { password, search, select } from "@inquirer/prompts";
import { listModels, listProviders } from "@opsremedy/core";
import type { OAuthCredentialRecord, OpsremedyConfig, OpsremedyCredentials } from "../../config.ts";
import { discoverProviderEnvVar } from "../../discover.ts";
import { isOAuthProvider, runOAuthLogin } from "../../oauth.ts";
import { formatExpiry, maskKey, preferredModelFor } from "../helpers.ts";

export interface LlmAnswers {
  provider: string;
  modelId: string;
  apiKey: string | undefined;
  oauth: OAuthCredentialRecord | undefined;
}

export async function sectionLlm(cfg: OpsremedyConfig, creds: OpsremedyCredentials): Promise<LlmAnswers> {
  console.log("== LLM ==");
  const providers = listProviders();
  const defaultProvider = providers.includes(cfg.llm?.provider as (typeof providers)[number])
    ? (cfg.llm?.provider as string)
    : "anthropic";

  const provider = await select<string>({
    message: "Provider",
    choices: providers.map((p) => ({ name: p, value: p })),
    default: defaultProvider,
  });

  const models = listModels(provider);
  if (models.length === 0) throw new Error(`Provider ${provider} has no models registered.`);
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(cfg.llm?.model ?? "")
    ? (cfg.llm?.model as string)
    : preferredModelFor(provider, modelIds);

  let modelId: string;
  if (modelIds.length > 12) {
    modelId = await search<string>({
      message: `Model (type to filter, ${modelIds.length} total)`,
      source: async (term) => {
        const t = (term ?? "").toLowerCase();
        const matches = modelIds.filter((id) => id.toLowerCase().includes(t));
        return matches.map((id) => ({ name: id === defaultModel ? `${id} (recommended)` : id, value: id }));
      },
    });
  } else {
    modelId = await select<string>({
      message: "Model",
      choices: modelIds.map((id) => ({ name: id, value: id })),
      default: defaultModel,
    });
  }

  const auth = await pickAuth(provider, creds);
  return { provider, modelId, apiKey: auth.apiKey, oauth: auth.oauth };
}

interface AuthAnswer {
  apiKey: string | undefined;
  oauth: OAuthCredentialRecord | undefined;
}

async function pickAuth(provider: string, creds: OpsremedyCredentials): Promise<AuthAnswer> {
  const envNames = discoverProviderEnvVar(provider);
  const supportsOAuth = isOAuthProvider(provider);
  const existingKey = creds.llm_keys?.[provider];
  const existingOAuth = creds.llm_oauth?.[provider];

  // Provider has neither OAuth nor static key (e.g. amazon-bedrock, google-vertex).
  if (!supportsOAuth && envNames.length === 0) {
    console.log(`  (${provider} uses ambient credentials — no key/OAuth prompt)`);
    return { apiKey: undefined, oauth: undefined };
  }

  const choices: Array<{ name: string; value: "oauth" | "key" | "keep" | "skip" }> = [];
  if (supportsOAuth) {
    choices.push({
      name: existingOAuth
        ? `Subscription / OAuth (currently linked, expires ${formatExpiry(existingOAuth.expires)})`
        : "Subscription / OAuth (e.g. Claude Pro/Max, ChatGPT Plus)",
      value: "oauth",
    });
  }
  if (envNames.length > 0) {
    choices.push({
      name: existingKey ? `API key (current: ${maskKey(existingKey)})` : `API key (${envNames.join(" or ")})`,
      value: "key",
    });
  }
  if (existingKey || existingOAuth) {
    choices.push({ name: "Keep existing credentials", value: "keep" });
  }
  choices.push({ name: "Skip (set credentials later)", value: "skip" });

  const choice = await select<"oauth" | "key" | "keep" | "skip">({
    message: "Authentication",
    choices,
    default: existingOAuth ? "oauth" : existingKey ? "key" : choices[0]?.value,
  });

  if (choice === "keep") {
    return { apiKey: undefined, oauth: undefined };
  }
  if (choice === "skip") {
    console.log("  (no credential saved — investigations will fail until you set one)");
    return { apiKey: undefined, oauth: undefined };
  }
  if (choice === "oauth") {
    console.log(`\nStarting ${provider} OAuth login...`);
    const tokens = await runOAuthLogin(provider);
    console.log(`  ✓ Linked. Refresh handled automatically.`);
    return { apiKey: undefined, oauth: tokens };
  }
  const entered = await password({
    message: `API key for ${provider} (env: ${envNames.join(" or ")}${existingKey ? `, blank to keep ${maskKey(existingKey)}` : ""})`,
    mask: "*",
    validate: (v) => v.length === 0 || v.length >= 10 || "key looks too short",
  });
  return {
    apiKey: entered || existingKey,
    oauth: undefined,
  };
}
