// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from 'vitest';

import { gridCuts } from '@web/spaces/canvas/mini-tool/grid-export';

// The tiles themselves are cut in the media container since inner#1968
// (design 3.2.2); their arithmetic is pinned with `gridTileRects` in shared.
describe('gridCuts', () => {
  it('places each cut where an even split of the side would', () => {
    expect(gridCuts(1007, 8)).toEqual([0, 126, 252, 378, 504, 629, 755, 881, 1007]);
  });
});
