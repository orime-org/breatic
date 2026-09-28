// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * MiniMax Speech 2.8 HD (#2156): the pronunciation dictionary is a list of
 * `{text, pronunciation}` entries on our side, the shape the panel's list
 * editor writes, and a list of `Alias/Pronunciation` strings upstream.
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/**
 * One entry's two halves, or undefined when either is missing.
 * @param entry - One stored entry; untrusted collaborative data.
 * @returns The entry as `original/reading`, or undefined.
 */
function asAlias(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { text, pronunciation } = entry as Record<string, unknown>;
  if (typeof text !== "string" || typeof pronunciation !== "string") return undefined;
  const original = text.trim();
  const reading = pronunciation.trim();
  return original !== "" && reading !== "" ? `${original}/${reading}` : undefined;
}

const minimaxSpeech: ModelFamily = {
  MODELS: new Set(["minimax-speech-2.8-hd"]),
  CONSUMES: new Set(["pronunciation_dict"]),
  /**
   * Send each complete dictionary entry as `original/reading`.
   * @param prompt - The lines to speak.
   * @param params - The validated run params.
   * @returns The prompt unchanged and the dictionary when any entry is complete.
   */
  prepare: async (
    prompt: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ prompt: string; fields: Record<string, unknown> }> => {
    const list = params.pronunciation_dict;
    const aliases = (Array.isArray(list) ? list : [])
      .map(asAlias)
      .filter((alias): alias is string => alias !== undefined);
    return { prompt, fields: aliases.length > 0 ? { pronunciation_dict: aliases } : {} };
  },
};

export default minimaxSpeech;
