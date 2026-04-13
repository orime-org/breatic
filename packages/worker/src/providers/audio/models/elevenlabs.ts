/**
 * ElevenLabs Audio model family -- sound effects.
 *
 * Handles ElevenLabs audio models (sfx-v2).
 * Converts `prompt` to `text` for API compatibility.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * elevenlabs-sfx-v2 (sfx):
 * - prompt             -> text (rename prompt -> text)
 * - duration_seconds   -> duration_seconds (pass-through)
 * - prompt_influence   -> prompt_influence (pass-through)
 * - loop               -> loop (pass-through)
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "elevenlabs-sfx-v2",
]);

/**
 * Convert user-facing params to API params for ElevenLabs audio models.
 *
 * Renames `prompt` to `text` to match ElevenLabs API naming.
 *
 * @param prompt - User's audio description
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params from YAML config
 * @returns Tuple of [prompt, apiParams] where apiParams uses `text` instead of `prompt`
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const apiParams = { ...params };
  // ElevenLabs API uses "text" instead of "prompt"
  delete apiParams.prompt;
  apiParams.text = prompt;
  return [prompt, apiParams];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
