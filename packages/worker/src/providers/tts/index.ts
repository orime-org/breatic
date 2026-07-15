// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * TTS provider package -- text-to-speech and voice cloning.
 *
 * Two-layer dispatch: model families ({@link ./models/}) convert params,
 * while transports ({@link ./transports/}) handle HTTP requests for each API.
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateTtsParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> build_request -> transport.generate
 */

import {
  resolveModel,
  acquireSemaphore,
  validateParams,
  type ModelFamily,
  type ResumeContext,
  type Transport,
} from "@worker/providers/shared.js";

// ── Model Families ──────────────────────────────────────────────────

import elevenlabs from "@worker/providers/tts/models/elevenlabs.js";
import fish from "@worker/providers/tts/models/fish.js";
import f5 from "@worker/providers/tts/models/f5.js";

// ── Transports ──────────────────────────────────────────────────────

import * as elevenlabsTransport from "@worker/providers/tts/transports/elevenlabs.js";
import * as fishTransport from "@worker/providers/tts/transports/fish.js";
import * as wavespeedTransport from "@worker/providers/tts/transports/wavespeed.js";
import * as falTransport from "@worker/providers/tts/transports/fal.js";

// ── Registry ────────────────────────────────────────────────────────

const ALL_FAMILIES: readonly ModelFamily[] = [
  elevenlabs,
  fish,
  f5,
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
  ["elevenlabs", elevenlabsTransport as Transport],
  ["fish", fishTransport as Transport],
  ["wavespeed", wavespeedTransport as Transport],
  ["fal", falTransport as Transport],
]);

/**
 * Look up the transport module for a provider.
 * @param providerName - Provider key (e.g. "elevenlabs")
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
 * Generate speech asynchronously with concurrency control.
 *
 * Uses a per-provider semaphore to limit concurrent requests.
 * @param prompt - Text to convert to speech
 * @param modelName - Model name (required)
 * @param params - Additional parameters passed to the model family
 * @param resume - Worker resume context for at-most-once submit (#1628)
 * @returns A dict with url, model, and cost
 * @throws {Error} if model or provider resolution fails
 */
export async function generateAsync(
  prompt: string,
  modelName: string | undefined,
  params: Record<string, unknown> = {},
  resume?: ResumeContext,
): Promise<{ url?: string; text?: string; model: string; cost: number }> {
  const resolved = resolveModel("tts", modelName);
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
  apiParams.text = formattedPrompt;

  const transport = getTransport(resolved.providerName);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);

  try {
    return await transport.generate(formattedPrompt, resolved, apiParams, resume);
  } finally {
    release();
  }
}

/**
 * Validate and fill defaults for TTS generation parameters.
 * @param modelName - Model name (required)
 * @param params - User-provided parameters to validate
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateTtsParams(
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams("tts", modelName, params);
}

