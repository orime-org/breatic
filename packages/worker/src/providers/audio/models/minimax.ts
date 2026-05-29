/**
 * MiniMax Music model family -- music generation and voice cloning.
 *
 * Handles MiniMax music models (music-01, music-2.5).
 * Parameters are mostly pass-through with minimal conversion.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * minimax-music-2.5 (t2m):
 * - prompt           -> prompt (pass-through)
 * - lyrics           -> lyrics (pass-through)
 * - is_instrumental  -> is_instrumental (pass-through)
 *
 * minimax-music-01 (a2m):
 * - prompt           -> prompt (pass-through)
 * - song             -> song (pass-through)
 * - voice            -> voice (pass-through)
 * - instrumental     -> instrumental (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "minimax-music-01",
  "minimax-music-2.5",
]);

/**
 * Convert user-facing params to API params for MiniMax music models.
 *
 * @param prompt - User's music description
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params from YAML config
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const apiParams = { ...params };
  // WaveSpeed requires lyrics (min 10 chars). Use prompt as fallback for instrumental.
  if (!apiParams.lyrics || (apiParams.lyrics as string).length < 10) {
    apiParams.lyrics = prompt || "instrumental music";
  }
  return [prompt, apiParams];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
