// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The light the relight sphere draws (inner#1304): its marker, glow and the
 * lit side of the card take the colour the reader picked, so the choice
 * shows on the sphere as it is made. Read off the relight model's own params.
 */

import { AUTO_LIGHT_SWATCH, lightColorOf } from '@breatic/shared';

import type { LightTint } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

/** Each intensity's strength on the sphere; Auto reads as Medium. */
const STRENGTH: Readonly<Record<string, number>> = { low: 0.35, medium: 0.6, high: 0.95 };

/**
 * The light a relight draft asks for, as the sphere draws it.
 * @param params - The draft, by the relight model's param names.
 * @returns Its colour and strength.
 */
export function lightTintOf(params: Readonly<Record<string, unknown>>): LightTint {
  return {
    color: lightColorOf(params.light_color, params.light_color_hex)?.swatch ?? AUTO_LIGHT_SWATCH,
    strength: STRENGTH[String(params.light_intensity)] ?? STRENGTH.medium!,
  };
}
