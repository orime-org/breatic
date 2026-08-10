// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Model narrowing shared by every generate panel.
 *
 * The image and video panels are separate components with separate params and
 * separate mode sets (user 2026-08-08), but "which models does this mode
 * offer" is one rule, not one per modality: a model belongs to a mode when its
 * `mode` field names it. Keeping a single implementation is what stops the two
 * panels from drifting on multi-mode entries.
 */

import type { ModelEntry } from '@breatic/shared';

/**
 * Keeps only the models offerable under a generation mode — those whose `mode`
 * names it. A multi-mode model (`["t2v", "i2v"]`) belongs to every mode it
 * names.
 *
 * The mode is a plain string here on purpose: each panel owns its own closed
 * mode union and narrows before calling, so this function does not need to
 * know which modality it is serving.
 *
 * A whole modality bucket is a valid input: naming a generation mode is itself
 * the test, so a mini-tool entry in the bucket simply fails to match. Callers
 * that pre-filter (the image panel does, for its own reasons) are welcome to,
 * but this function does not require it.
 * @param models - Catalog models to narrow — a whole modality bucket is fine.
 * @param mode - The active generation mode.
 * @returns The models matching the mode, in input order.
 */
export function filterModelsByMode(
  models: ModelEntry[],
  mode: string,
): ModelEntry[] {
  return models.filter((m) =>
    (Array.isArray(m.mode) ? m.mode : [m.mode]).includes(mode),
  );
}

/**
 * Picks which model a mode should open with, in priority order (user
 * 2026-07-11): the one the user last chose in that mode if it is still in the
 * catalog, else the first model the mode offers. The `recommended` tier is
 * deliberately NOT consulted — it is a curation BADGE (a mode may carry
 * several recommended models), not a default-selection rule; an earlier
 * resolution misread it as one.
 *
 * Alongside {@link filterModelsByMode} because it is the same kind of rule:
 * one answer to "which model does this mode open with", shared by both panels
 * rather than one copy per modality that can drift on the memory semantics.
 * The mode is a plain string for the same reason — each panel owns its own
 * closed mode union and narrows before calling.
 * @param mode - The active generation mode.
 * @param modelByMode - Per-mode memory of the last-chosen model name.
 * @param filteredModels - The models this mode offers (from {@link filterModelsByMode}).
 * @returns The model name to select, or undefined when the mode offers none.
 */
export function resolveModelForMode(
  mode: string,
  modelByMode: Partial<Record<string, string>>,
  filteredModels: ModelEntry[],
): string | undefined {
  const remembered = modelByMode[mode];
  if (remembered && filteredModels.some((m) => m.name === remembered)) {
    return remembered;
  }
  return filteredModels[0]?.name;
}
