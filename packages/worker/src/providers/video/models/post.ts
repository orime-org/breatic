/**
 * Video post-processing model family -- upscaling and frame interpolation.
 *
 * Handles all video post-processing models.  {@link buildRequest} converts
 * user-facing params to WaveSpeed API format.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - video_url -> video (rename for WaveSpeed)
 * - target_resolution -> pass-through
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "video-upscale-pro",
  "rife-interpolation",
]);

/**
 * Convert user-facing params to provider-specific API params.
 *
 * Post-processing models do not use a text prompt -- the prompt arg
 * is passed through but typically empty.
 *
 * @param prompt - Unused for post-processing (passed through as empty)
 * @param _modelName - Resolved model name (e.g. "video-upscale-pro")
 * @param params - Validated params from YAML defaults + user input
 * @param _providerName - Target provider ("wavespeed")
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
  _providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) filtered[k] = v;
  }

  const api: Record<string, unknown> = {};

  // Rename: video_url -> video (WaveSpeed API param name)
  const videoUrl = filtered.video_url;
  delete filtered.video_url;
  if (videoUrl) {
    api.video = videoUrl;
  }

  // Pass through remaining params (e.g. target_resolution)
  Object.assign(api, filtered);

  return [prompt, api];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
