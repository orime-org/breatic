// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { followViewport, sameRect, visibleRect, type FlowRect } from '@web/features/follow/follow-geometry';
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from '@web/lib/canvas-zoom';

describe('visibleRect', () => {
  it('turns a viewport transform and pane size into the flow rectangle on screen', () => {
    expect(visibleRect({ x: -200, y: -100, zoom: 2 }, { width: 800, height: 600 }))
      .toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });
});

describe('followViewport', () => {
  it('shows the whole leader rectangle when the panes have the same aspect', () => {
    const rect = { x: 100, y: 50, width: 400, height: 300 };
    const next = followViewport(rect, { width: 800, height: 600 });
    expect(visibleRect(next, { width: 800, height: 600 })).toEqual(rect);
  });

  it('fits the leader rectangle inside a pane of another aspect, centred', () => {
    const rect = { x: 0, y: 0, width: 400, height: 300 };
    const pane = { width: 1000, height: 300 };
    const next = followViewport(rect, pane);
    const shown = visibleRect(next, pane);
    expect(shown.x).toBeLessThanOrEqual(rect.x + 1e-6);
    expect(shown.y).toBeLessThanOrEqual(rect.y + 1e-6);
    expect(shown.x + shown.width).toBeGreaterThanOrEqual(rect.x + rect.width - 1e-6);
    expect(shown.y + shown.height).toBeGreaterThanOrEqual(rect.y + rect.height - 1e-6);
    expect(next.zoom).toBeCloseTo(1, 6);
    expect(shown.x + shown.width / 2).toBeCloseTo(rect.x + rect.width / 2, 6);
  });

  it('stays inside the canvas zoom range', () => {
    expect(followViewport({ x: 0, y: 0, width: 1e7, height: 1e7 }, { width: 800, height: 600 }).zoom).toBe(CANVAS_MIN_ZOOM);
    expect(followViewport({ x: 0, y: 0, width: 1, height: 1 }, { width: 800, height: 600 }).zoom).toBe(CANVAS_MAX_ZOOM);
  });
});

describe('sameRect', () => {
  it('compares the four edges and treats a missing rectangle as equal only to another', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(sameRect(rect, { ...rect })).toBe(true);
    expect(sameRect(rect, { ...rect, height: 5 })).toBe(false);
    expect(sameRect(null, rect)).toBe(false);
    expect(sameRect(undefined, null)).toBe(true);
  });
});

describe('the published camera while following', () => {
  it('keeps two members following each other on one rectangle whatever their pane shapes', () => {
    fc.assert(
      fc.property(
        fc.record({ width: fc.integer({ min: 200, max: 3000 }), height: fc.integer({ min: 200, max: 2000 }) }),
        fc.record({ width: fc.integer({ min: 200, max: 3000 }), height: fc.integer({ min: 200, max: 2000 }) }),
        fc.integer({ min: 2, max: 12 }),
        (paneA, paneB, rounds) => {
          const start = visibleRect({ x: -40, y: -30, zoom: 1 }, paneA);
          // A starts the exchange with its own rectangle; from then on each side
          // fits what the other published and publishes the leader rectangle
          // while following drives its viewport, else its own (leader ?? own).
          const leaderOrOwn = (leader: FlowRect | null, own: FlowRect): FlowRect => leader ?? own;
          let publishedByA = leaderOrOwn(null, start);
          let publishedByB = publishedByA;
          for (let round = 0; round < rounds; round += 1) {
            publishedByB = leaderOrOwn(publishedByA, visibleRect(followViewport(publishedByA, paneB), paneB));
            publishedByA = leaderOrOwn(publishedByB, visibleRect(followViewport(publishedByB, paneA), paneA));
          }
          expect(publishedByA).toEqual(start);
          expect(publishedByB).toEqual(start);
        },
      ),
    );
  });
});
