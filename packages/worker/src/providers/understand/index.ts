// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Understand provider package -- multimodal analysis and transcription.
 *
 * Two execution paths: model families ({@link ./models/}) build requests,
 * transports ({@link ./transports/}) handle execution.
 *
 * - LLM path (vi/vv/va): model family builds messages -> litellm transport
 * - ASR path (transcribe): model family builds params -> wavespeed transport
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateUnderstandParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> build -> transport.generate
 */

import {
  resolveModel,
  acquireSemaphore,
  validateParams,
  type ResumeContext,
} from "@worker/providers/shared.js";
import type { AnyUnderstandFamily } from "@worker/providers/understand/models/types.js";

// ── Model Families ──────────────────────────────────────────────────

import gemini from "@worker/providers/understand/models/gemini.js";
import whisper from "@worker/providers/understand/models/whisper.js";

// ── Transports ──────────────────────────────────────────────────────

import * as litellmTransport from "@worker/providers/understand/transports/litellm.js";
import * as wavespeedTransport from "@worker/providers/understand/transports/wavespeed.js";

// ── Registry ────────────────────────────────────────────────────────

const ALL_FAMILIES: readonly AnyUnderstandFamily[] = [
  gemini,
  whisper,
];

/** Model name -> model family module. */
const _MODEL_FAMILIES = new Map<string, AnyUnderstandFamily>();
for (const family of ALL_FAMILIES) {
  for (const name of family.MODELS) {
    _MODEL_FAMILIES.set(name, family);
  }
}

/** Understand transport signature. */
type UnderstandTransportFn = (
  resolved: Parameters<typeof litellmTransport.generate>[0],
  family: AnyUnderstandFamily,
  prompt: string,
  params: Record<string, unknown>,
  resume?: ResumeContext,
) => Promise<{ text: string; cost: number }>;

/** Provider name -> transport generate function. */
const _TRANSPORTS = new Map<string, UnderstandTransportFn>([
  ["gemini", litellmTransport.generate],
  ["openrouter", litellmTransport.generate],
  ["wavespeed", wavespeedTransport.generate],
]);

/**
 * Look up the transport generate function for a provider.
 * @param providerName - Provider key (e.g. "gemini", "wavespeed")
 * @returns The transport generate function
 * @throws {Error} if no transport is registered for the provider
 */
function getTransport(providerName: string): UnderstandTransportFn {
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
 * Analyze media content or transcribe audio.
 *
 * Resolves the model, builds the request via the model family, then
 * dispatches to the appropriate transport (LiteLLM or WaveSpeed).
 * @param prompt - Analysis instruction or empty string for transcribe
 * @param modelName - Model name (required)
 * @param params - Additional parameters (images, video_url, audio_url, etc.)
 * @param resume - Worker resume context for at-most-once async submit (#1628)
 * @returns Object with text (result), model, and cost
 * @throws {Error} if model or provider resolution fails
 */
export async function generateAsync(
  prompt: string,
  modelName: string | undefined,
  params: Record<string, unknown> = {},
  resume?: ResumeContext,
): Promise<{ text: string; model: string; cost: number }> {
  const resolved = resolveModel("understand", modelName);
  const family = _MODEL_FAMILIES.get(resolved.modelName);
  if (!family) {
    throw new Error(
      `No model family registered for '${resolved.modelName}'. ` +
      `Available: ${[..._MODEL_FAMILIES.keys()].sort().join(", ")}`,
    );
  }

  const transport = getTransport(resolved.providerName);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);

  try {
    const result = await transport(resolved, family, prompt, params, resume);
    return {
      text: result.text,
      model: resolved.modelName,
      cost: result.cost,
    };
  } finally {
    release();
  }
}

/**
 * Validate and fill defaults for understand analysis parameters.
 * @param modelName - Model name (required)
 * @param params - User-provided parameters to validate
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateUnderstandParams(
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams("understand", modelName, params);
}

