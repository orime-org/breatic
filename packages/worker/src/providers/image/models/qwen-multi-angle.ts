/**
 * Qwen Multi-Angle model family -- multi-view generation from single image.
 *
 * Uses Qwen-Image-Edit with Multiple-Angles LoRA via WaveSpeed API.
 * The key conversion is image (single URL) to images (array), as
 * WaveSpeed expects an array.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - image            -> images (wrap in array)
 * - horizontal_angle -> pass-through
 * - vertical_angle   -> pass-through
 * - distance         -> pass-through
 * - prompt           -> pass-through
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "qwen-multi-angle",
]);

/**
 * Build WaveSpeed multi-angle API request.
 *
 * @param prompt - User's image description (used as optional guidance)
 * @param modelName - Resolved model name
 * @param params - Validated params (image, horizontal_angle, vertical_angle, distance, prompt)
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const p = { ...params };
  const apiParams: Record<string, unknown> = {};

  // WaveSpeed expects images as an array
  const image = p.image;
  delete p.image;
  if (image) {
    apiParams.images = [image];
  }

  // Camera controls -- pass through
  for (const key of ["horizontal_angle", "vertical_angle", "distance"] as const) {
    const value = p[key];
    delete p[key];
    if (value !== undefined && value !== null) {
      apiParams[key] = value;
    }
  }

  // Optional guidance prompt
  const userPrompt = p.prompt;
  delete p.prompt;
  if (userPrompt) {
    apiParams.prompt = userPrompt;
  }

  return [prompt, apiParams];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
