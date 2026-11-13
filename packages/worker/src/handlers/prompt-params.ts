// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Taking the user's prompt out of a task's params (#1966).
 *
 * The prompt travels to provider beside the params, never inside them; each binding writes it under its upstream's
 * `prompt_field`. Validation drops keys a model does not declare, so the prompt is lifted out of the bag before the
 * params are validated, and a model that declares no `prompt` param still receives the user's words.
 */

import { extractPromptText } from "@breatic/shared";

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
 * The music models' `lyrics` is cleaned here too, on the far side of the
 * validator — same mandate, different carrier (#1960).
 * @param params - Task params with the infra-only fields already stripped.
 * @param model - The model to validate against.
 * @param validateParams - The model's param check (`validateModelParams`).
 * @returns A `[prompt, resolvedModel, validated]` triple: the cleaned prompt, the model name the provider resolved to, and the params it accepted.
 */
export function takePromptAndValidate(
  params: Record<string, unknown>,
  model: string,
  validateParams: ValidateParams,
): [string, string, Record<string, unknown>] {
  const [prompt, promptless] = takePromptOutOfParams(params);
  // Every text setting (a 3D negative prompt, a voice description, a motion
  // prompt) and every text field of a list's entries (a storyboard shot's
  // prompt, a speaker's name) is cleaned by the validator, which knows from
  // the model's declaration which ones are text.
  const [resolvedModel, validated] = validateParams(model, promptless);
  // The lyrics are the second thing a user types into a rich-text editor on
  // the way to a provider (#1960), and the mandate that every AIGC prompt is
  // stripped of HTML, comments and invisible characters is about what the user
  // typed, not about which argument carries it. They stay INSIDE the bag
  // because the vendor reads `lyrics` as a declared param rather than as the
  // positional prompt — so this is a clean, not a lift.
  //
  // After validation, not before: a model that does not declare the field has
  // had it dropped by then, and cleaning a value nothing will send is work on
  // a key that no longer exists.
  const cleaned: Record<string, unknown> =
    typeof validated.lyrics === "string"
      ? { ...validated, lyrics: extractPromptText(validated.lyrics) }
      : { ...validated };
  return [prompt, resolvedModel, cleaned];
}

