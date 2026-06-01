/**
 * Whisper model family -- speech-to-text transcription via WaveSpeed.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * whisper-turbo (transcribe):
 * - audio, language -- all pass-through
 */

import type { UnderstandAsrFamily } from "@worker/providers/understand/models/types.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "whisper-turbo",
]);

/**
 * Build WaveSpeed Whisper API request params.
 * @param prompt - Optional guidance prompt for Whisper formatting
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params (audio URL, language, etc.)
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const apiParams = { ...params };
  if (prompt) {
    apiParams.prompt = prompt;
  }
  return [prompt, apiParams];
}

export default { MODELS, buildRequest } satisfies UnderstandAsrFamily;
