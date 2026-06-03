// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fish Speech model family -- cost-effective TTS.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * fish-s2-pro (tts):
 * - text         -> text (pass-through)
 * - reference_id -> reference_id (pass-through)
 * - speed        -> speed (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "fish-s2-pro",
]);

/**
 * Convert user-facing params to API params for Fish Speech.
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
