// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image panel's slots: the style slot, shared with the video panel and
 * defined in `style-slot.ts` (inner#826, inner#828). This registry is where
 * the cross-registry lookups find it.
 */

import type { SlotSpec } from '@web/spaces/canvas/generate/slots';
import { STYLE_SLOT } from '@web/spaces/canvas/generate/style-slot';

/** The slots the image panel can offer. */
export type ImageSlot = 'style';

/** Every image slot, by name. */
export const IMAGE_SLOTS = {
  style: STYLE_SLOT,
} as const satisfies Readonly<Record<ImageSlot, SlotSpec>>;
