// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image panel's slots (inner#826): the style slot, holding up to the
 * model's `style_images` cap of pick-time copies. Its facts live here so the
 * toolbar, the canvas pick, the candidate highlighting, the asset accounting
 * and the payload read one entry.
 */

import { Box } from 'lucide-react';

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
