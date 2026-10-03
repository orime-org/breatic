// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image panel's slots: the style slot, shared with the video panel and
 * defined in `style-slot.ts` (inner#826, inner#828). This registry is where
 * the cross-registry lookups find it.
 */

import type { ModelEntry } from '@breatic/shared';

import { filledFromCanvas } from '@web/spaces/canvas/generate/canvas-filled';
import type { SlotSpec } from '@web/spaces/canvas/generate/slots';
import { STYLE_SLOT } from '@web/spaces/canvas/generate/style-slot';

/** The slots the image panel can offer. */
export type ImageSlot = 'style';

/** Every image slot, by name. */
export const IMAGE_SLOTS = {
  style: STYLE_SLOT,
} as const satisfies Readonly<Record<ImageSlot, SlotSpec>>;

/** Every image slot, in the order the toolbar draws them. */
const IMAGE_SLOT_ORDER: readonly ImageSlot[] = ['style'];

/**
 * The slots the toolbar draws for this model in this mode.
 * @param model - The model the run names, or undefined before one resolves.
 * @param mode - The mode it is set to.
 * @returns The slots the model fills off the canvas in that mode.
 */
export function imageSlotsForModel(model: ModelEntry | undefined, mode: string): readonly ImageSlot[] {
  if (model === undefined) return [];
  return IMAGE_SLOT_ORDER.filter(
    (slot) => filledFromCanvas(model.params[IMAGE_SLOTS[slot].param], mode) !== undefined,
  );
}
