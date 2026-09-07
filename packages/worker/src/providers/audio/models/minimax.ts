// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * MiniMax Music model family -- music generation and reference-based writing.
 *
 * Parameters are mostly pass-through with minimal conversion.
 *
 * Parameter mapping (YAML user-facing vs API):
 *
 * minimax-music-3.0 (t2m):
 * - prompt           -> prompt (pass-through)
 * - lyrics           -> lyrics (pass-through)
 * - is_instrumental  -> is_instrumental (pass-through)
 *
 * minimax-music-01 (a2m):
 * - prompt           -> prompt (pass-through)
 * - lyrics           -> lyrics (pass-through)
 * - song             -> song (pass-through)
 * - voice            -> voice (pass-through)
 * - instrumental     -> instrumental (pass-through)
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "minimax-music-01",
  "minimax-music-3.0",
]);

/**
 * Convert user-facing params to API params for MiniMax music models.
 *
 * Pass-through. The lyrics travel exactly as written, which is what the
 * gateway takes -- measured 2026-09-05: `lyrics: "la"` is accepted and
 * completes, and `lyrics: ""` with `is_instrumental: true` is accepted and
 * completes. This module used to substitute the style brief below ten
 * characters, a floor read off the vendor page rather than measured; on a
 * two-word lyric that put the user's own "warm indie folk, 90 BPM" into the
 * song as words to sing. What the gateway does refuse -- an empty lyrics on a
 * vocal run -- the panel refuses first, and states why.
 * @param prompt - User's music description
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
