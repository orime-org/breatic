/**
 * Meshy 6 model family -- high-quality 3D generation with PBR textures.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * meshy6-t23d (t23d):
 * - prompt, art_style, topology, target_polycount, enable_pbr,
 *   symmetry_mode, ta_pose -- all pass-through
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "meshy6-t23d",
]);

/**
 * Convert user-facing params to API params for Meshy 6 models.
 * @param prompt - 3D object description
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
