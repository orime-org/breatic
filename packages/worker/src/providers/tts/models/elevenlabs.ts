// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * ElevenLabs TTS model family -- high-quality text-to-speech.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * elevenlabs-v3 (tts):
 * - text       -> text (pass-through)
 * - voice_id   -> voice_id (pass-through)
 * - stability  -> stability (pass-through)
 * - similarity -> similarity (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "elevenlabs-v3",
]);

/**
 * Convert user-facing params to API params for ElevenLabs TTS.
 * @param prompt - Text to convert to speech
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
