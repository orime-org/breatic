// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Image generation provider package.
 *
 * Two-layer dispatch: model families ({@link ./models/}) format prompts and
 * convert params, while transports ({@link ./transports/}) handle HTTP
 * requests for each API.
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateImageParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> build_request -> transport.generate
 * - {@link listAvailableImageModels} -- list models with active API keys
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

import nanoBanana from "@worker/providers/image/models/nano-banana.js";
import seedream from "@worker/providers/image/models/seedream.js";
import midjourney from "@worker/providers/image/models/midjourney.js";
import qwen from "@worker/providers/image/models/qwen.js";
// B5 (`design/project/02-mini-tool-system.md` §2.2): V1 image roster =
// remove-bg / upscale / inpaint. The `qwen-multi-angle` + `ic-light`
// families served `multi-angle` / `relight` which were trimmed from the
// registry + schema; their model files are gone. The generative-node
// families (nano-banana / seedream / midjourney / qwen text-to-image)
// stay because they're called by the generative pipeline, not the
// mini-tool route.
import topaz from "@worker/providers/image/models/topaz.js";
import backgroundRemove from "@worker/providers/image/models/background-remove.js";

// ── Transports ──────────────────────────────────────────────────────

import * as wavespeedTransport from "@worker/providers/image/transports/wavespeed.js";
import * as googleTransport from "@worker/providers/image/transports/google.js";
import * as byteplusTransport from "@worker/providers/image/transports/byteplus.js";
import * as dashscopeTransport from "@worker/providers/image/transports/dashscope.js";
import * as topazTransport from "@worker/providers/image/transports/topaz.js";

// ── Registry ────────────────────────────────────────────────────────

const ALL_FAMILIES: readonly ModelFamily[] = [
  nanoBanana,
  seedream,
  midjourney,
  qwen,
  topaz,
  backgroundRemove,
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
  ["google", googleTransport as Transport],
  ["byteplus", byteplusTransport as Transport],
  ["dashscope", dashscopeTransport as Transport],
  ["topaz", topazTransport as Transport],
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
 * Generate an image asynchronously with concurrency control.
 *
 * Uses a per-provider semaphore to limit concurrent requests.
 * @param prompt - Image description prompt
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
  const resolved = resolveModel("image", modelName);
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

  const transport = getTransport(resolved.providerName);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);

  try {
    return await transport.generate(formattedPrompt, resolved, apiParams);
  } finally {
    release();
  }
}

/**
 * Validate and fill defaults for image generation parameters.
 * @param modelName - Model name (required)
 * @param params - User-provided parameters to validate
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateImageParams(
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams("image", modelName, params);
}

/**
 * List all image models that have at least one provider with an active API key.
 * @returns Array of model info dicts for skill injection
 */
export function listAvailableImageModels(): ReturnType<typeof listAvailableModels> {
  return listAvailableModels("image");
}
