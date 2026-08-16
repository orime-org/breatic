// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `takes_prompt` (#1966) — the single home for "does this model consume the
 * text the user writes".
 *
 * It used to have none. The video panel derived it from whether the model
 * declared a `prompt` under `params`; the image panel hardcoded `true` and
 * said why in a comment — not one image model declares that param, so the
 * video panel's derivation would have switched the requirement off for the
 * whole image catalog at once. Two panels, two answers, and the declaration
 * they disagreed about was a per-catalog writing habit rather than a rule.
 *
 * The field is declared per MODEL, not per mode: a mode can carry several
 * models, and the moment two of them differ a mode-level answer starts
 * lying (#1935 settled the same point for the same reason).
 *
 * Absence is an error, never `false`. Someone adding a model is as likely to
 * have meant `true`, and defaulting to `false` would silently unmount the
 * prompt editor with nothing anywhere going red.
 */

/** The part of a catalog entry this check reads. */
interface TakesPromptCandidate {
  /** Model name as authored in yaml — named in the error so it can be found. */
  name: string;
  /** Whether the model consumes the user's text; must be present. */
  takes_prompt?: boolean;
}

/**
 * Assert that every model in one modality states `takes_prompt`.
 *
 * Called by the catalog loader, and preheated at every service entry so a
 * typo surfaces when the deployment starts rather than under the first user
 * who opens a Generate panel.
 * @param modality - The modality being loaded, named in the error.
 * @param models - The models parsed out of that modality's yaml files.
 * @throws {Error} when any model omits the field or gives it a non-boolean.
 */
export function assertTakesPromptDeclared(
  modality: string,
  models: readonly TakesPromptCandidate[],
): void {
  const offenders = models
    .filter((m) => typeof m.takes_prompt !== "boolean")
    .map((m) => m.name);
  if (offenders.length === 0) return;
  throw new Error(
    `config/models/${modality}: every model must declare takes_prompt ` +
      `(true or false); missing or not a boolean on: ${offenders.join(", ")}`,
  );
}
