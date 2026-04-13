/**
 * Video generation provider package.
 *
 * Two-layer dispatch: model families ({@link ./models/}) format prompts and
 * convert params, while transports ({@link ./transports/}) handle HTTP
 * requests for each API.
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateVideoParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> build_request -> transport.generate
 * - {@link listAvailableVideoModels} -- list models with active API keys
 */

import {
  resolveModel,
  acquireSemaphore,
  validateParams,
  listAvailableModels,
  type ModelFamily,
  type Transport,
} from "../shared.js";

// ── Model Families ──────────────────────────────────────────────────

import kling from "./models/kling.js";
import wan from "./models/wan.js";
import seedance from "./models/seedance.js";
import veo from "./models/veo.js";
import omnihuman from "./models/omnihuman.js";
import post from "./models/post.js";

// ── Transports ──────────────────────────────────────────────────────

import * as wavespeedTransport from "./transports/wavespeed.js";
import * as klingaiTransport from "./transports/klingai.js";
import * as byteplusTransport from "./transports/byteplus.js";
import * as googleTransport from "./transports/google.js";

// ── Registry ────────────────────────────────────────────────────────

const ALL_FAMILIES: readonly ModelFamily[] = [
  kling,
  wan,
  seedance,
  veo,
  omnihuman,
  post,
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
  ["klingai", klingaiTransport as Transport],
  ["byteplus", byteplusTransport as Transport],
  ["google", googleTransport as Transport],
]);

/**
 * Look up the transport module for a provider.
 *
 * @param providerName - Provider key (e.g. "wavespeed")
 * @returns The transport module
 * @throws Error if no transport is registered for the provider
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
 * Generate a video asynchronously with concurrency control.
 *
 * Uses a per-provider semaphore to limit concurrent requests.
 *
 * @param prompt - Video description prompt
 * @param modelName - Model name (required)
 * @param params - Additional parameters passed to the model family
 * @returns A dict with url, model, and cost (actual API cost in USD)
 * @throws Error if model or provider resolution fails
 */
export async function generateAsync(
  prompt: string,
  modelName: string | undefined,
  params: Record<string, unknown> = {},
): Promise<{ url?: string; text?: string; model: string; cost: number }> {
  const resolved = resolveModel("video", modelName);
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
    resolved.providerName,
  );

  const transport = getTransport(resolved.providerName);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);

  try {
    return await transport.generate(formattedPrompt, resolved, apiParams);
  } finally {
    release();
  }
}

/**
 * Validate and fill defaults for video generation parameters.
 *
 * @param modelName - Model name (required)
 * @param params - User-provided parameters to validate
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateVideoParams(
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams("video", modelName, params);
}

/**
 * List all video models that have at least one provider with an active API key.
 *
 * @returns Array of model info dicts for skill injection
 */
export function listAvailableVideoModels() {
  return listAvailableModels("video");
}
