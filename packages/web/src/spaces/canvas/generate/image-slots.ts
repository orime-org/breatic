// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one source slot the image panel offers, and what it is made of (#269).
 *
 * Image-to-image takes its material through the reference pool, so the style
 * reference is the only thing this panel collects by pointing at a node. It
 * was written out four times — the param name in the view model and in the
 * payload builder, the icon and translation keys inline in the toolbar — and
 * a slot spread across a panel is what let the first frame ship telling a
 * reader to "select a reference" (#1902).
 *
 * Narrower than {@link ./slots}'s `SlotSpec`: this slot's pick is stored and
 * routed by the canvas itself (`CanvasSpace` dispatches on the `style` pick
 * purpose), so the fields that registry carries for routing would have no
 * reader here. Every field below has one.
 */

import { Box } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** What the image panel's one slot is made of. */
interface ImageSlotSpec {
  /** The param the URL travels as, under the vendor's own name. */
  param: string;
  /** Icon shown while the slot is empty. */
  Icon: LucideIcon;
  /** Test id of the slot control. */
  testId: string;
  /** Test id of the filled thumbnail. */
  thumbnailTestId: string;
  /** Test id of the clear badge. */
  clearTestId: string;
  /** Translation key for the slot's label. */
  labelKey: string;
  /** Translation key for the one line saying what to go pick. */
  tipKey: string;
  /** Translation key for the clear badge's accessible name. */
  clearLabelKey: string;
}

/** Every image slot, by name. */
export const IMAGE_SLOTS = {
  style: {
    param: 'style_images',
    Icon: Box,
    testId: 'generate-tool-style',
    thumbnailTestId: 'generate-style-thumbnail',
    clearTestId: 'generate-style-clear',
    labelKey: 'canvas.generatePanel.style',
    tipKey: 'canvas.generatePanel.styleTip',
    clearLabelKey: 'canvas.generatePanel.removeStyle',
  },
} as const satisfies Readonly<Record<string, ImageSlotSpec>>;
