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
