/**
 * OmniHuman model family -- ByteDance talking head generation (1.5).
 *
 * Handles OmniHuman (talking_head mode).  WaveSpeed is the only provider.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - image -> pass-through (portrait URL)
 * - audio -> pass-through (WAV/MP3 URL)
 * - All params pass-through
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "omnihuman-1.5",
]);

/**
 * Convert user-facing params to WaveSpeed API params.
 *
 * @param prompt - Unused for talking head (driven by audio)
 * @param _modelName - Always "omnihuman-1.5"
 * @param params - Validated params from YAML defaults + user input
 * @param _providerName - Always "wavespeed" (only provider)
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
  _providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleaned[k] = v;
  }
  if (cleaned.seed === -1) delete cleaned.seed;

  return [prompt, { ...cleaned }];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
