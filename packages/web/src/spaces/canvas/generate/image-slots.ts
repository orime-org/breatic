// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image panel's slots (inner#826): the style slot, holding up to the
 * model's `style_images` cap of pick-time copies. Its facts live here so the
 * toolbar, the canvas pick, the candidate highlighting, the asset accounting
 * and the payload read one entry.
 */

import type { ModelEntry } from '@breatic/shared';
import { Box } from 'lucide-react';

import { filledFromCanvas } from '@web/spaces/canvas/generate/canvas-filled';
import type { SlotSpec } from '@web/spaces/canvas/generate/slots';

/** The slots the image panel can offer. */
export type ImageSlot = 'style';

/** Every image slot, by name. */
export const IMAGE_SLOTS = {
  style: {
    field: 'styleImageUrls',
    multiple: true,
    param: 'style_images',
    purpose: 'style',
    accepts: 'image',
    Icon: Box,
    testId: 'generate-tool-style',
    thumbnailTestId: 'generate-style-thumbnail',
    clearTestId: 'generate-style-clear',
    labelKey: 'canvas.generatePanel.style',
    tipKey: 'canvas.generatePanel.styleTip',
    clearLabelKey: 'canvas.generatePanel.removeStyle',
    errorKey: 'canvas.generatePanel.errorNoStyleImage',
  },
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
