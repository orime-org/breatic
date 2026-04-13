/**
 * Hunyuan3D model family -- Tencent 3D generation.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * hunyuan3d-v3 (t23d):
 * - prompt, generate_type, enable_pbr, face_count -- all pass-through
 *
 * hunyuan3d-v3-i23d (i23d):
 * - image, back_image, left_image, right_image,
 *   generate_type, enable_pbr, face_count -- all pass-through
 *
 * hunyuan3d-v3.1-rapid (i23d):
 * - image -- pass-through
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "hunyuan3d-v3",
  "hunyuan3d-v3-i23d",
  "hunyuan3d-v3.1-rapid",
]);

/**
 * Convert user-facing params to API params for Hunyuan3D models.
 *
 * @param prompt - 3D object description (t23d) or empty (i23d)
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params from YAML config
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  return [prompt, { ...params }];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
