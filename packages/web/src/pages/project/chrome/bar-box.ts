// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

interface ChromeBarBox {
  /** How far the contents are held off the left and right edges. */
  sides: string;
  /** The space between the things in the bar. */
  gap: string;
}

/**
 * The band a 40px chrome bar occupies.
 *
 * Three bars are drawn this way -- the top bar, the agent column's header and
 * the space tab bar -- and each carries a 1px rule along its bottom. The rule
 * is inside the 40, so centring against what is left of them puts the
 * contents half a pixel above the middle of the band a reader sees; the pixel
 * on top balances it. Two of these bars sit side by side on the same line, so
 * balancing one and not the others is what pulls them out of line with each
 * other -- which is why the box is stated here rather than at each bar.
 *
 * The studio shell draws a fourth bar of the same height (`StudioTopBar`).
 * It is never on screen beside these three, so nothing lines up against it
 * and it is left as it is.
 * @param root0 - What this bar wants of its own.
 * @param root0.sides - How far the contents are held off the left and right edges.
 * @param root0.gap - The space between the things in the bar.
 * @returns The style the bar carries.
 */
export function chromeBarBox({ sides, gap }: ChromeBarBox): React.CSSProperties {
  return { height: 40, paddingTop: 1, paddingInline: sides, gap };
}
