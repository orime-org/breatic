// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The image panel's slots: the style slot, shared with the video panel and
 * defined in `style-slot.ts` (inner#826, inner#828). This registry is where
 * the cross-registry lookups find it.
 */

import type { SlotSpec } from '@shared/canvas/model/slots.js';
import { STYLE_SLOT } from '@shared/canvas/model/style-slot.js';

/** The slots the image panel can offer. */
export type ImageSlot = 'style';

/** Every image slot, by name. */
export const IMAGE_SLOTS = {
  style: STYLE_SLOT,
} as const satisfies Readonly<Record<ImageSlot, SlotSpec>>;
