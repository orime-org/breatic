// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The style slot, shared by the image and video Generate panels (inner#826,
 * inner#828): up to the model's `style_images` cap of pick-time copies. Its
 * facts live here so both toolbars, the canvas pick, the candidate
 * highlighting, the asset accounting and the payload read one entry.
 *
 * Registered once, as `IMAGE_SLOTS.style`: the lookups that span registries
 * (`slotForPurpose`, `slotSpec`, `allSlotSpecs`) find it there for both
 * panels.
 */

import { itemCap, type ModelEntry } from '@breatic/shared';
import { Palette } from 'lucide-react';

import { filledFromCanvas } from '@web/spaces/canvas/generate/canvas-filled';
import type { SlotSpec } from '@web/spaces/canvas/generate/slots';

/** The style slot's facts. */
export const STYLE_SLOT = {
  field: 'styleImageUrls',
  multiple: true,
  param: 'style_images',
  purpose: 'style',
  accepts: 'image',
  Icon: Palette,
  testId: 'generate-tool-style',
  thumbnailTestId: 'generate-style-thumbnail',
  clearTestId: 'generate-style-clear',
  labelKey: 'canvas.generatePanel.style',
  tipKey: 'canvas.generatePanel.styleTip',
  clearLabelKey: 'canvas.generatePanel.removeStyle',
  errorKey: 'canvas.generatePanel.errorNoStyleImage',
} as const satisfies SlotSpec;

/**
 * How many style images this model takes in this mode.
 * @param model - The model the run names, or undefined before one resolves.
 * @param mode - The mode it is set to.
 * @returns The cap, or undefined when the model fills no style images off the
 *   canvas in that mode and no style area is drawn.
 */
export function styleCapFor(model: ModelEntry | undefined, mode: string): number | undefined {
  const spec = model?.params[STYLE_SLOT.param];
  if (spec === undefined || filledFromCanvas(spec, mode) === undefined) return undefined;
  return itemCap(spec);
}

/**
 * The style slot as a drawn slot, for the lists that track which slots a
 * panel shows (the running pick ends when its slot leaves the list).
 * @param styleCap - The cap {@link styleCapFor} answered.
 * @returns `['style']` when the area is drawn, else nothing.
 */
export function styleSlotsFor(styleCap: number | undefined): readonly 'style'[] {
  return styleCap === undefined ? [] : ['style'];
}
