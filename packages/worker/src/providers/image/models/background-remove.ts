/**
 * Background remove model family -- AI background removal.
 *
 * Minimal pass-through: sends only the image URL to the provider API.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - image -> image (pass-through)
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "bg-remover",
]);

/**
 * Build background removal API request.
 *
 * @param prompt - Not used for background removal
 * @param modelName - Resolved model name
 * @param params - Validated params (image only)
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const api: Record<string, unknown> = {};

  const image = params.image;
  if (image !== undefined && image !== null) {
    api.image = image;
  }

  return [prompt, api];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
