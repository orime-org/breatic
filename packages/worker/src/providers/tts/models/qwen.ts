// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Qwen3 TTS model family -- zero-shot voice cloning.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * qwen3-tts-voice-clone (voice_clone):
 * - text  -> text (pass-through; the tts entry point fills it from the prompt)
 * - audio -> audio (pass-through; the reference recording to clone)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "qwen3-tts-voice-clone",
]);

/**
 * Convert user-facing params to API params for Qwen3 voice cloning.
 * @param prompt - Lines to speak in the cloned voice
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params from YAML config plus the picked source
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
