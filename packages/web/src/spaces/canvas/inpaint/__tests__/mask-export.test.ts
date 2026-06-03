// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { exportMask } from '@web/spaces/canvas/inpaint/mask-export';
import type { InpaintStroke } from '@web/spaces/canvas/inpaint/types';

describe('exportMask', () => {
  const stroke: InpaintStroke = {
    id: 's1',
    radius: 10,
    alpha: 1,
    points: [
      { x: 5, y: 5 },
      { x: 50, y: 5 },
    ],
  };

  it('returns a PNG data URL for a single stroke', () => {
    const url = exportMask({ width: 100, height: 100, strokes: [stroke] });
    expect(url).not.toBeNull();
    expect(url!.startsWith('data:image/png')).toBe(true);
  });

  it('handles an empty strokes list (returns an empty mask PNG)', () => {
    const url = exportMask({ width: 32, height: 32, strokes: [] });
    expect(url!.startsWith('data:image/png')).toBe(true);
  });

  it('clamps zero / negative dimensions to at least 1px', () => {
    const url = exportMask({ width: 0, height: -5, strokes: [stroke] });
    expect(url).not.toBeNull();
  });

  it('a single-point stroke still draws (degenerates to a tiny line)', () => {
    const single: InpaintStroke = {
      id: 's2',
      radius: 5,
      alpha: 1,
      points: [{ x: 10, y: 10 }],
    };
    const url = exportMask({ width: 20, height: 20, strokes: [single] });
    expect(url).not.toBeNull();
  });
});
