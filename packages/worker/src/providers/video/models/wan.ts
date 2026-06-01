/**
 * Wan model family -- Alibaba video generation (2.2 Animate only).
 *
 * Handles the Wan 2.2 Animate model for character image animation.
 * Only the WaveSpeed transport is used.
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "wan-2.2-animate",
]);

/**
 * Convert user-facing params to provider-specific API params.
 * @param prompt - User's video description
 * @param _modelName - Resolved model name
 * @param params - Validated params from YAML defaults + user input
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleaned[k] = v;
  }
  if (cleaned.seed === -1) delete cleaned.seed;

  return [prompt, cleaned];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
