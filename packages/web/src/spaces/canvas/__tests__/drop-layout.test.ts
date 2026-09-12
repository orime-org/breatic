// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { dropPositionAt } from '@web/spaces/canvas/drop-layout';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';

const ORIGIN = { x: 100, y: 200 };

/** The first index after the first that starts a row again. */
function firstWrap(): number {
  for (let i = 1; i < 64; i += 1) {
    if (dropPositionAt(ORIGIN, i).x === ORIGIN.x) return i;
  }
  throw new Error('the layout never wraps');
}

describe('dropPositionAt', () => {
  it('puts the first file where the drop landed', () => {
    expect(dropPositionAt(ORIGIN, 0)).toEqual(ORIGIN);
  });

  it('steps neighbours a whole node apart, so neither hides the other', () => {
    const second = dropPositionAt(ORIGIN, 1);
    expect(second.x - ORIGIN.x).toBeGreaterThanOrEqual(EMPTY_NODE_SIZE.width);
    expect(second.y).toBe(ORIGIN.y);
  });

  it('wraps to a new row rather than running off to the right', () => {
    const wrap = firstWrap();
    const nextRow = dropPositionAt(ORIGIN, wrap);
    expect(nextRow.y - ORIGIN.y).toBeGreaterThanOrEqual(
      EMPTY_NODE_SIZE.height,
    );
  });

  it('keeps a row narrow enough to sit in a desktop viewport', () => {
    const last = dropPositionAt(ORIGIN, firstWrap() - 1);
    expect(last.x - ORIGIN.x + EMPTY_NODE_SIZE.width).toBeLessThanOrEqual(1280);
  });

  it('lays a batch out so no two nodes share a position', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const at = dropPositionAt(ORIGIN, i);
      seen.add(`${at.x},${at.y}`);
    }
    expect(seen.size).toBe(20);
  });
});
