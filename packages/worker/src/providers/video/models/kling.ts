/**
 * Kling model family -- KwaiVGI video generation (O3, O1, V3 Motion).
 *
 * Handles all Kling video models across generations and modes (t2v, i2v,
 * ref, edit, motion).  {@link buildRequest} branches on `providerName`
 * to convert user-facing params to each provider's API format.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - wavespeed: generate_audio -> sound
 * - klingai: image -> image_url, end_image -> tail_image_url,
 *   element_list -> elements, video -> video_url, duration -> string
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  // O3
  "kling-o3-pro", "kling-o3-pro-i2v",
  "kling-o3-pro-ref", "kling-o3-pro-edit",
  // V3 Motion
  "kling-v3-pro-motion",
]);

/**
 * Build WaveSpeed API params for Kling models.
 *
 * WaveSpeed naming:
 * - `generate_audio` -> `sound`
 * - Other params pass-through
 */
function buildWavespeed(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const api = { ...params };

  // Rename: generate_audio -> sound
  const generateAudio = api.generate_audio;
  delete api.generate_audio;
  if (generateAudio != null) {
    api.sound = generateAudio;
  }

  return [prompt, api];
}

/**
 * Build Kling official API params.
 *
 * Official naming:
 * - `image` -> `image_url`
 * - `end_image` -> `tail_image_url`
 * - `element_list` -> `elements`
 * - `video` -> `video_url`
 * - `duration` -> string ("5")
 */
function buildKlingai(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const api = { ...params };

  // Rename: image -> image_url
  const image = api.image;
  delete api.image;
  if (image != null) {
    api.image_url = image;
  }

  // Rename: end_image -> tail_image_url
  const endImage = api.end_image;
  delete api.end_image;
  if (endImage != null) {
    api.tail_image_url = endImage;
  }

  // Rename: element_list -> elements
  const elementList = api.element_list;
  delete api.element_list;
  if (elementList != null) {
    api.elements = elementList;
  }

  // Rename: video -> video_url (edit mode)
  const video = api.video;
  delete api.video;
  if (video != null) {
    api.video_url = video;
  }

  // Duration must be string for official API
  if (api.duration != null) {
    api.duration = String(api.duration);
  }

  return [prompt, api];
}

/**
 * Convert user-facing params to provider-specific API params.
 *
 * @param prompt - User's video description
 * @param modelName - Resolved model name (e.g. "kling-o3-pro")
 * @param params - Validated params from YAML defaults + user input
 * @param providerName - Target provider ("wavespeed" or "klingai")
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
  providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  // Remove null/undefined values and default seed
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleaned[k] = v;
  }
  if (cleaned.seed === -1) delete cleaned.seed;

  if (providerName === "klingai") {
    return buildKlingai(prompt, modelName, cleaned);
  }
  return buildWavespeed(prompt, modelName, cleaned);
}

export default { MODELS, buildRequest } satisfies ModelFamily;
