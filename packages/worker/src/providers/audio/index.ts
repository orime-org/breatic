/**
 * Audio generation provider package -- music, sound effects, and separation.
 *
 * Two-layer dispatch: model families ({@link ./models/}) convert params,
 * while transports ({@link ./transports/}) handle HTTP requests for each API.
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateAudioParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> build_request -> transport.generate
 * - {@link listAvailableAudioModels} -- list models with active API keys
 */

import {
  resolveModel,
  acquireSemaphore,
  validateParams,
  listAvailableModels,
  type ModelFamily,
  type Transport,
} from "@worker/providers/shared.js";

// ── Model Families ──────────────────────────────────────────────────

import minimax from "@worker/providers/audio/models/minimax.js";
import elevenlabs from "@worker/providers/audio/models/elevenlabs.js";
import vocalRemover from "@worker/providers/audio/models/vocal-remover.js";

// ── Transports ──────────────────────────────────────────────────────

import * as wavespeedTransport from "@worker/providers/audio/transports/wavespeed.js";
import * as minimaxTransport from "@worker/providers/audio/transports/minimax.js";
import * as elevenlabsTransport from "@worker/providers/audio/transports/elevenlabs.js";
import * as falTransport from "@worker/providers/audio/transports/fal.js";

// ── Registry ────────────────────────────────────────────────────────

const ALL_FAMILIES: readonly ModelFamily[] = [
  minimax,
  elevenlabs,
  vocalRemover,
];

/** Model name -> model family module. */
const _MODEL_FAMILIES = new Map<string, ModelFamily>();
for (const family of ALL_FAMILIES) {
  for (const name of family.MODELS) {
    _MODEL_FAMILIES.set(name, family);
  }
}

/** Provider name -> transport module. */
const _TRANSPORTS = new Map<string, Transport>([
  ["wavespeed", wavespeedTransport as Transport],
  ["minimax", minimaxTransport as Transport],
  ["elevenlabs", elevenlabsTransport as Transport],
  ["fal", falTransport as Transport],
]);

/**
 * Look up the transport module for a provider.
 * @param providerName - Provider key (e.g. "wavespeed")
 * @returns The transport module
 * @throws {Error} if no transport is registered for the provider
 */
function getTransport(providerName: string): Transport {
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
 * Generate audio asynchronously with concurrency control.
 *
 * Uses a per-provider semaphore to limit concurrent requests.
 * @param prompt - Audio description prompt
 * @param modelName - Model name (required)
 * @param params - Additional parameters passed to the model family
 * @returns A dict with url, model, and cost (actual API cost in USD)
 * @throws {Error} if model or provider resolution fails
 */
export async function generateAsync(
  prompt: string,
  modelName: string | undefined,
  params: Record<string, unknown> = {},
): Promise<{ url?: string; text?: string; model: string; cost: number }> {
  const resolved = resolveModel("audio", modelName);
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
  apiParams.prompt = formattedPrompt;

  const transport = getTransport(resolved.providerName);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);

  try {
    return await transport.generate(formattedPrompt, resolved, apiParams);
  } finally {
    release();
  }
}

/**
 * Validate and fill defaults for audio generation parameters.
 * @param modelName - Model name (required)
 * @param params - User-provided parameters to validate
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateAudioParams(
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams("audio", modelName, params);
}

/**
 * List all audio models that have at least one provider with an active API key.
 * @returns Array of model info dicts for skill injection
 */
export function listAvailableAudioModels(): ReturnType<typeof listAvailableModels> {
  return listAvailableModels("audio");
}
