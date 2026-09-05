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

/** The one model whose upstream refuses a request without lyrics. */
const LYRICS_REQUIRED = "minimax-music-3.0";

/**
 * Convert user-facing params to API params for MiniMax music models.
 *
 * The lyrics fallback applies to `minimax-music-3.0` alone. Its gateway
 * answers `invalid params, lyrics is required` for an empty value and rejects
 * anything under ten characters (measured 2026-09-05), and what it substitutes
 * is the STYLE brief -- so a user writing "warm indie folk, 90 BPM" would hear
 * those words sung. The panel refuses an empty lyrics box before submitting,
 * which leaves this covering only the under-ten case and a request built
 * outside the panel. `minimax-music-01` states lyrics as optional and empty
 * stays empty there: substituting the brief would put words into a song the
 * user asked to have none.
 * @param prompt - User's music description
 * @param modelName - Resolved model name, which decides the fallback above
 * @param params - Validated params from YAML config
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const apiParams = { ...params };
  if (modelName === LYRICS_REQUIRED) {
    const lyrics = apiParams.lyrics;
    if (typeof lyrics !== "string" || lyrics.length < 10) {
      apiParams.lyrics = prompt || "instrumental music";
    }
  }
  return [prompt, apiParams];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
