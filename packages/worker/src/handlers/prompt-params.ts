// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Taking the user's prompt out of a task's params (#1966).
 *
 * The prompt travels to a provider as a POSITIONAL argument, never inside
 * `params` — each provider puts it back under whatever key its transports
 * expect (`apiParams.prompt` for audio, `apiParams.text` for tts). So every
 * execution path has to lift it out of the bag on the way in.
 *
 * Both paths used to do that inline, in OPPOSITE orders: the direct AIGC path
 * lifted first and validated the rest, the mini-tool path validated first and
 * read the prompt off the validated result. Nothing surfaced the difference
 * until a model stopped declaring `prompt` under `params` — `validateParams`
 * drops undeclared keys silently — and on the mini-tool path the user's words
 * stopped arriving. One shared function is what removes the second copy that
 * could drift, and what lets the declaration be deleted at all.
 */

import { extractPromptText } from "@breatic/domain";

/**
 * Lift the prompt out of a params bag, leaving the bag without it.
 *
 * `prompt` wins over `text` when both are present; `text` is what the TTS
 * models carry the same argument under. The result runs through
 * `extractPromptText` per the mandate that every AIGC prompt is stripped of
 * HTML, comments and invisible characters before it reaches a provider.
 * @param params - The task params as submitted.
 * @returns A `[prompt, rest]` tuple: the cleaned prompt (empty when the bag carries neither key) and a copy of the bag with both keys removed.
 */
export function takePromptOutOfParams(
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const prompt = extractPromptText(params.prompt ?? params.text);
  const rest = { ...params };
  delete rest.prompt;
  delete rest.text;
  return [prompt, rest];
}
