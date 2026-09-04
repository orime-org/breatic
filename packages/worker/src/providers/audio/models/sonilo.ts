// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sonilo Audio model family -- sound effects.
 *
 * The upstream reads `prompt`, `duration` and `audio_format` under exactly the
 * names the catalog declares, so nothing here renames anything. The family
 * exists because `generateAsync` looks one up per model name and throws when
 * there is none.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * sonilo-sfx-v1 (sfx):
 * - prompt         -> prompt (assigned by the dispatcher after this returns)
 * - duration       -> duration (pass-through)
 * - audio_format   -> audio_format (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "sonilo-sfx-v1",
]);

/**
 * Hand the validated params through unchanged.
 * @param prompt - The sound the user described
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params from YAML config
 * @returns Tuple of [prompt, apiParams], the params exactly as given
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  return [prompt, { ...params }];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
