// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * VEO model family -- Google video generation (3.1, 3).
 *
 * Handles all VEO video models across generations and modes (t2v, i2v,
 * extend).  {@link buildRequest} branches on `providerName` to convert
 * user-facing params to each provider's API format.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - wavespeed: all pass-through
 * - google: duration -> durationSeconds, generate_audio -> generateAudio,
 *   negative_prompt -> negativePrompt, aspect_ratio -> aspectRatio
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "veo-3.1", "veo-3.1-i2v",
  "veo-3.1-fast",
  "veo-3.1-extend",
  "veo-3.1-lite",
]);

/**
 * Build WaveSpeed API params for VEO models.
 *
 * WaveSpeed uses snake_case names matching our YAML -- mostly pass-through.
 * @param prompt - User's video description, returned unchanged
 * @param _modelName - Resolved model name (unused; WaveSpeed mapping is model-agnostic)
 * @param params - Validated params, passed through unchanged
 * @returns Tuple of [prompt, apiParams] in WaveSpeed format
 */
function buildWavespeed(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return [prompt, { ...params }];
}

/**
 * Build Google official API params for VEO models.
 *
 * Google naming:
 * - `duration` -> `durationSeconds`
 * - `generate_audio` -> `generateAudio`
 * - `negative_prompt` -> `negativePrompt`
 * - `aspect_ratio` -> `aspectRatio`
 * @param prompt - User's video description, returned unchanged
 * @param _modelName - Resolved model name (unused; Google mapping is model-agnostic)
 * @param params - Validated params to map into Google official naming
 * @returns Tuple of [prompt, apiParams] in Google official format
 */
function buildGoogle(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const api = { ...params };

  // Rename: duration -> durationSeconds
  const duration = api.duration;
  delete api.duration;
  if (duration != null) {
    api.durationSeconds = duration;
  }

  // Rename: generate_audio -> generateAudio
  const generateAudio = api.generate_audio;
  delete api.generate_audio;
  if (generateAudio != null) {
    api.generateAudio = generateAudio;
  }

  // Rename: negative_prompt -> negativePrompt
  const negativePrompt = api.negative_prompt;
  delete api.negative_prompt;
  if (negativePrompt != null) {
    api.negativePrompt = negativePrompt;
  }

  // Rename: aspect_ratio -> aspectRatio
  const aspectRatio = api.aspect_ratio;
  delete api.aspect_ratio;
  if (aspectRatio != null) {
    api.aspectRatio = aspectRatio;
  }

  return [prompt, api];
}

/**
 * Convert user-facing params to provider-specific API params.
 * @param prompt - User's video description
 * @param modelName - Resolved model name (e.g. "veo-3.1")
 * @param params - Validated params from YAML defaults + user input
 * @param providerName - Target provider ("wavespeed" or "google")
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
  providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleaned[k] = v;
  }
  if (cleaned.seed === -1) delete cleaned.seed;

  if (providerName === "google") {
    return buildGoogle(prompt, modelName, cleaned);
  }
  return buildWavespeed(prompt, modelName, cleaned);
}

export default { MODELS, buildRequest } satisfies ModelFamily;
