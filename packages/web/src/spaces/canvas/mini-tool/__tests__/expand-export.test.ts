// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the source sits on the expand tool's padded canvas (inner#1303 §6.3).
 * The raster half is checked in the browser.
 */

import { describe, it, expect } from 'vitest';

import { expandLayout } from '@web/spaces/canvas/mini-tool/expand-export';

describe('expandLayout', () => {
  it('sizes the canvas to the frame in source pixels and puts the source where the frame leaves it', () => {
    expect(expandLayout({ x: -0.25, y: -0.1, width: 1.5, height: 1.3 }, { width: 1600, height: 1000 })).toEqual({
      width: 2400,
      height: 1300,
      sourceX: 400,
      sourceY: 100,
    });
  });

  it('rounds to whole pixels and never cuts into the source', () => {
    const layout = expandLayout({ x: -0.3333, y: 0, width: 1.6667, height: 1 }, { width: 999, height: 500 });
    expect(Number.isInteger(layout.width)).toBe(true);
    expect(layout.sourceX + 999).toBeLessThanOrEqual(layout.width);
    expect(layout.height).toBe(500);
  });
});
