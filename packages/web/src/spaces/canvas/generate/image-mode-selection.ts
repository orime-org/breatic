// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ModelEntry } from '@breatic/shared';

/**
 * The two generation modes the user toggles between: text-to-image and
 * image-to-image. A model belongs to a mode when its `mode` field includes
 * that value (a multi-mode `["i2i", "edit"]` model belongs to `i2i`).
 */
export type ImageGenMode = 't2i' | 'i2i';

/**
 * Keeps only the models offerable under a generation mode — those whose `mode`
 * includes it. Layered on top of the slice-1 "generatable models" filter so the
 * picker shows one clean list per mode instead of every t2i/i2i variant at once.
 * @param models - The catalog image models (already filtered to generatable).
 * @param mode - The active generation mode.
 * @returns The models matching the mode, in input order.
 */
export function filterModelsByMode(
  models: ModelEntry[],
  mode: ImageGenMode,
): ModelEntry[] {
  return models.filter((m) =>
    (Array.isArray(m.mode) ? m.mode : [m.mode]).includes(mode),
  );
}

/**
 * Picks which model should be selected for a mode, in priority order (user
 * 2026-07-11): the one the user last chose in that mode if still in the
 * catalog, else the first available model for the mode. The `recommended`
 * tier is deliberately NOT consulted — it is a curation BADGE (a mode may
 * carry several recommended models), not a default-selection rule; an
 * earlier resolution misread it as one. Returns undefined when no model
 * exists for the mode.
 * @param mode - The active generation mode.
 * @param modelByMode - Per-mode memory of the last-chosen model name.
 * @param filteredModels - The models available for this mode (from {@link filterModelsByMode}).
 * @returns The model name to select, or undefined when the mode has no models.
 */
export function resolveModelForMode(
  mode: ImageGenMode,
  modelByMode: Partial<Record<ImageGenMode, string>>,
  filteredModels: ModelEntry[],
): string | undefined {
  const remembered = modelByMode[mode];
  if (remembered && filteredModels.some((m) => m.name === remembered)) {
    return remembered;
  }
  return filteredModels[0]?.name;
}
