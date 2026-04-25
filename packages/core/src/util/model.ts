import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";

/**
 * Pi-ai's `getModel`/`getModels`/`getProviders` use literal-union types generated
 * from their built-in registry. We accept arbitrary runtime strings (from user
 * config), so cast at the boundary in one place. If pi-ai's signatures change,
 * fix them here only.
 */

type GetModelArgs = Parameters<typeof getModel>;
type GetModelsArg = Parameters<typeof getModels>[0];

export function resolveModel(provider: string, model: string): ReturnType<typeof getModel> {
  return getModel(provider as GetModelArgs[0], model as GetModelArgs[1]);
}

export function listModels(provider: string): ReturnType<typeof getModels> {
  return getModels(provider as GetModelsArg);
}

export function listProviders(): ReturnType<typeof getProviders> {
  return getProviders();
}
