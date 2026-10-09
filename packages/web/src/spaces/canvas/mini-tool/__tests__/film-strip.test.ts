// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { filmstripTimes, filmstripCount } from '@web/spaces/canvas/mini-tool/FilmStrip';

describe('filmstripTimes', () => {
  // Each tile shows the moment at its own middle.
  it('samples the middle of each tile', () => {
    expect(filmstripTimes(8, 4)).toEqual([1, 3, 5, 7]);
  });

  it('samples nothing for no tiles', () => {
    expect(filmstripTimes(8, 0)).toEqual([]);
  });
});

describe('filmstripCount', () => {
  // A 16:9 source on a 36px band is 64px a tile; the band is filled to its end.
  it('fills the band with tiles of the source shape', () => {
    expect(filmstripCount(318, 36, 16 / 9)).toBe(5);
  });

  it('draws one tile while the band has no width yet', () => {
    expect(filmstripCount(0, 36, 16 / 9)).toBe(1);
  });
});
