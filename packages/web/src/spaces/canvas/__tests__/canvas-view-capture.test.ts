// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { visibleNodeIds, flowAreaOnScreen } from '@web/spaces/canvas/canvas-view-capture';

describe('flowAreaOnScreen', () => {
  it('turns the viewport transform and the box size into the flow area on screen', () => {
    expect(flowAreaOnScreen([-100, -50, 2], { width: 800, height: 600 })).toEqual({ x: 50, y: 25, width: 400, height: 300 });
  });
});

describe('visibleNodeIds', () => {
  const view = { x: 0, y: 0, width: 100, height: 100 };

  it('lists nodes inside or overlapping the view, and none outside', () => {
    expect(
      visibleNodeIds(
        [
          { id: 'in', x: 10, y: 10, width: 20, height: 20 },
          { id: 'edge', x: 90, y: 90, width: 50, height: 50 },
          { id: 'out', x: 200, y: 0, width: 10, height: 10 },
        ],
        view,
      ),
    ).toEqual(['in', 'edge']);
  });

  it('agrees with a plain overlap test', () => {
    fc.assert(
      fc.property(fc.integer({ min: -300, max: 300 }), fc.integer({ min: -300, max: 300 }), fc.integer({ min: 1, max: 200 }), (x, y, s) => {
        const hit = visibleNodeIds([{ id: 'n', x, y, width: s, height: s }], view).length === 1;
        expect(hit).toBe(x < 100 && x + s > 0 && y < 100 && y + s > 0);
      }),
    );
  });
});
