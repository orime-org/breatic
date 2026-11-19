// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';

/** One checker cell's side in screen pixels. */
const CHECKER_PX = 6;

/**
 * The canvas checkerboard: a low-contrast fill in either theme for an area with no picture of its own, the area an
 * expansion's model paints (the convention Photoshop's Generative Expand shows) and the transparency behind an alpha
 * picture. The cells are counted from the picture's own corner, so a frame and the cover over a node's picture lay the
 * same grid.
 * @param scale - Canvas pixels per screen pixel at the zoom.
 * @param from - Where the picture's corner is from the element's top-left, in canvas pixels.
 * @param from.x - Across.
 * @param from.y - Down.
 * @returns The element's background.
 * @throws {never} Never.
 */
export function checkerboardStyle(scale: number, from: { x: number; y: number }): React.CSSProperties {
  const cell = CHECKER_PX * scale;
  return {
    backgroundImage: 'repeating-conic-gradient(var(--color-muted) 0 25%, var(--color-background) 0 50%)',
    backgroundSize: `${cell * 2}px ${cell * 2}px`,
    backgroundPosition: `${from.x}px ${from.y}px`,
  };
}
