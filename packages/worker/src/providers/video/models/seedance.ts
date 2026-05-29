/**
 * Seedance model family -- ByteDance video generation (2.0, 1.5, 1.0 Lite).
 *
 * Handles all Seedance video models across generations and modes (t2v, i2v,
 * ref, extend).  {@link buildRequest} branches on `providerName` to convert
 * user-facing params to each provider's API format.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - wavespeed: end_image -> last_image
 * - byteplus: image -> image_url, end_image -> end_image_url,
 *   video -> video_url
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "seedance-2.0",
  "seedance-1.5-pro-i2v",
]);

/**
 * Build WaveSpeed API params for Seedance models.
 *
 * WaveSpeed naming:
 * - `end_image` -> `last_image`
 * - Other params pass-through
 */
function buildWavespeed(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const api = { ...params };

  // Rename: end_image -> last_image
  const endImage = api.end_image;
  delete api.end_image;
  if (endImage != null) {
    api.last_image = endImage;
  }

  return [prompt, api];
}

/**
 * Build BytePlus official API params for Seedance models.
 *
 * BytePlus naming:
 * - `image` -> `image_url`
 * - `end_image` -> `end_image_url`
 * - `video` -> `video_url`
 */
function buildByteplus(
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

  // Rename: end_image -> end_image_url
  const endImage = api.end_image;
  delete api.end_image;
  if (endImage != null) {
    api.end_image_url = endImage;
  }

  // Rename: video -> video_url (extend)
  const video = api.video;
  delete api.video;
  if (video != null) {
    api.video_url = video;
  }

  return [prompt, api];
}

/**
 * Convert user-facing params to provider-specific API params.
 *
 * @param prompt - User's video description
 * @param modelName - Resolved model name (e.g. "seedance-1.5-pro")
 * @param params - Validated params from YAML defaults + user input
 * @param providerName - Target provider ("wavespeed" or "byteplus")
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

  if (providerName === "byteplus") {
    return buildByteplus(prompt, modelName, cleaned);
  }
  return buildWavespeed(prompt, modelName, cleaned);
}

export default { MODELS, buildRequest } satisfies ModelFamily;
