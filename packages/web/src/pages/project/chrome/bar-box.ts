// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

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
 * @param sides - How far the contents are held off the left and right edges.
 * @param gap - The space between the things in the bar.
 * @returns The style the bar carries.
 */
export function chromeBarBox(sides: string, gap: string): React.CSSProperties {
  return { height: 40, padding: `1px ${sides} 0`, gap };
}
