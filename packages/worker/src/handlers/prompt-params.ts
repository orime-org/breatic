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
 * Two of the three paths `dispatch.ts` numbers used to do that inline, in
 * OPPOSITE orders: the direct AIGC path lifted first and validated the rest,
 * the mini-tool path validated first and read the prompt off the validated
 * result. (`runUnderstand`, which `dispatch.ts` numbers path 2, lifts inline
 * too, but it builds its params from scratch and never validates them, so it
 * has no order to get wrong and stays outside this module.) Nothing surfaced the difference
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
 *
 * Module-private: every caller goes through {@link takePromptAndValidate},
 * because the ORDER of these two steps is the invariant (#1967) and a lifted
 * prompt with unvalidated params is a half-done state no path wants.
 * @returns A `[prompt, rest]` tuple: the cleaned prompt (empty when the bag carries neither key) and a copy of the bag with both keys removed.
 */
function takePromptOutOfParams(
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const prompt = extractPromptText(params.prompt ?? params.text);
  const rest = { ...params };
  delete rest.prompt;
  delete rest.text;
  return [prompt, rest];
}

/** Drops keys the model does not declare, and fills declared defaults. */
type ValidateParams = (
  model: string,
  params: Record<string, unknown>,
) => [string, Record<string, unknown>];

/**
 * Lift the prompt out, THEN validate what is left — as one step.
 *
 * The order is the whole point, and one shared function is the only thing that
 * keeps it. Validation drops keys the model does not declare, so validating
 * first and reading the prompt off the result makes every prompt depend on
 * every model declaring a `prompt` param — a declaration that says nothing
 * about the model, and that no image model ever wrote. That is exactly how the
 * two execution paths came to run in opposite orders (#1967): each spelled the
 * two steps out inline, and only one of them got the order right.
 *
 * Sharing `takePromptOutOfParams` alone would not have prevented it — both
 * paths could still call it on either side of validation. Sharing the ORDER is
 * what makes the defect unwritable: a caller gets one call, and there is
 * nothing left to sequence.
 * @param params - Task params with the infra-only fields already stripped.
 * @param model - The model to validate against.
 * @param validateParams - The provider's validator.
 * @returns A `[prompt, resolvedModel, validated]` triple: the cleaned prompt, the model name the provider resolved to, and the params it accepted.
 */
export function takePromptAndValidate(
  params: Record<string, unknown>,
  model: string,
  validateParams: ValidateParams,
): [string, string, Record<string, unknown>] {
  const [prompt, promptless] = takePromptOutOfParams(params);
  const [resolvedModel, validated] = validateParams(model, promptless);
  return [prompt, resolvedModel, validated];
}
