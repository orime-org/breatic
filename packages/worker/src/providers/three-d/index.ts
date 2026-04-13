/**
 * 3D generation provider package -- text-to-3d and image-to-3d.
 *
 * Two-layer dispatch: model families ({@link ./models/}) convert params,
 * while transports ({@link ./transports/}) handle HTTP requests for each API.
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateThreeDParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> build_request -> transport.generate
 * - {@link listAvailableThreeDModels} -- list models with active API keys
 */

import {
  resolveModel,
  acquireSemaphore,
  validateParams,
  listAvailableModels,
  type ModelFamily,
} from "../shared.js";

// ── Model Families ──────────────────────────────────────────────────

import meshy from "./models/meshy.js";
import hunyuan3d from "./models/hunyuan3d.js";

// ── Transports ──────────────────────────────────────────────────────

import * as wavespeedTransport from "./transports/wavespeed.js";

// ── Registry ────────────────────────────────────────────────────────

const ALL_FAMILIES: readonly ModelFamily[] = [
  meshy,
  hunyuan3d,
];

/** Model name -> model family module. */
const _MODEL_FAMILIES = new Map<string, ModelFamily>();
for (const family of ALL_FAMILIES) {
  for (const name of family.MODELS) {
    _MODEL_FAMILIES.set(name, family);
  }
}

/** Provider name -> transport generate function. */
const _TRANSPORTS = new Map<string, typeof wavespeedTransport.generate>([
  ["wavespeed", wavespeedTransport.generate],
]);

/**
 * Look up the transport generate function for a provider.
 *
 * @param providerName - Provider key (e.g. "wavespeed")
 * @returns The transport generate function
 * @throws Error if no transport is registered for the provider
 */
function getTransport(providerName: string): typeof wavespeedTransport.generate {
  const transport = _TRANSPORTS.get(providerName);
  if (!transport) {
    throw new Error(
      `No transport registered for provider '${providerName}'. ` +
      `Available: ${[..._TRANSPORTS.keys()].join(", ")}`,
    );
  }
  return transport;
}

/**
 * Generate a 3D model asynchronously with concurrency control.
 *
 * Uses a per-provider semaphore to limit concurrent requests.
 *
 * @param prompt - 3D object description prompt
 * @param modelName - Model name (required)
 * @param params - Additional parameters passed to the model family
 * @returns Object with url, model, and cost (actual API cost in USD)
 * @throws Error if model or provider resolution fails
 */
export async function generateAsync(
  prompt: string,
  modelName: string | undefined,
  params: Record<string, unknown> = {},
): Promise<{ url: string; model: string; cost: number }> {
  const resolved = resolveModel("three_d", modelName);
  const family = _MODEL_FAMILIES.get(resolved.modelName);
  if (!family) {
    throw new Error(
      `No model family registered for '${resolved.modelName}'. ` +
      `Available: ${[..._MODEL_FAMILIES.keys()].sort().join(", ")}`,
    );
  }

  const [formattedPrompt, apiParams] = await family.buildRequest(
    prompt,
    resolved.modelName,
    params,
  );
  (apiParams as Record<string, unknown>).prompt = formattedPrompt;

  const transport = getTransport(resolved.providerName);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);

  try {
    return await transport(formattedPrompt, resolved, apiParams);
  } finally {
    release();
  }
}

/**
 * Validate and fill defaults for 3D generation parameters.
 *
 * @param modelName - Model name (required)
 * @param params - User-provided parameters to validate
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateThreeDParams(
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams("three_d", modelName, params);
}

/**
 * List all 3D models that have at least one provider with an active API key.
 *
 * @returns Array of model info dicts for skill injection
 */
export function listAvailableThreeDModels() {
  return listAvailableModels("three_d");
}
