/**
 * F5 TTS model family -- zero-shot voice cloning.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * f5-tts (voice_clone):
 * - text          -> text (pass-through)
 * - ref_audio_url -> ref_audio_url (pass-through)
 * - ref_text      -> ref_text (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "f5-tts",
]);

/**
 * Convert user-facing params to API params for F5 TTS voice cloning.
 * @param prompt - Text to speak in cloned voice
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
