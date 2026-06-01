/**
 * Vocal Remover model family -- audio separation.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * vocal-remover (separate):
 * - audio -> audio (pass-through)
 * - mode  -> mode (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "vocal-remover",
]);

/**
 * Convert user-facing params to API params for Vocal Remover.
 * @param prompt - Unused for audio separation
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params (audio URL, mode)
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
