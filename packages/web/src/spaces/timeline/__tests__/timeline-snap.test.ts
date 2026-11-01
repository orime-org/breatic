// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Snapping during drags and trims (inner#1708 E9, design §2.5). */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { TIMELINE_SNAP_PX, snapTimelineEdges, timelineSnapTargets } from '@web/spaces/timeline/timeline-snap';
import { MAIN, cid, clip, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';

describe('snapTimelineEdges', () => {
  it('uses an 8px threshold', () => {
    expect(TIMELINE_SNAP_PX).toBe(8);
  });

  it('snaps an edge exactly 8px away and not one 8.5px away', () => {
    // At half a pixel per frame, 16 frames are 8px and 17 frames are 8.5px.
    expect(snapTimelineEdges([100], [116], 0.5, TIMELINE_SNAP_PX)).toEqual({ shift: 16, frame: 116 });
    expect(snapTimelineEdges([100], [84], 0.5, TIMELINE_SNAP_PX)).toEqual({ shift: -16, frame: 84 });
    expect(snapTimelineEdges([100], [117], 0.5, TIMELINE_SNAP_PX)).toBe(null);
    expect(snapTimelineEdges([100], [83], 0.5, TIMELINE_SNAP_PX)).toBe(null);
  });

  it('measures the threshold in pixels at the current zoom', () => {
    expect(snapTimelineEdges([100], [104], 2, TIMELINE_SNAP_PX)).toEqual({ shift: 4, frame: 104 });
    expect(snapTimelineEdges([100], [105], 2, TIMELINE_SNAP_PX)).toBe(null);
  });

  it('picks the nearest target', () => {
    expect(snapTimelineEdges([100], [95, 104], 1, TIMELINE_SNAP_PX)).toEqual({ shift: 4, frame: 104 });
    expect(snapTimelineEdges([100], [97, 106], 1, TIMELINE_SNAP_PX)).toEqual({ shift: -3, frame: 97 });
  });

  it('lets whichever edge is nearer snap when both edges take part', () => {
    expect(snapTimelineEdges([100, 148], [150], 1, TIMELINE_SNAP_PX)).toEqual({ shift: 2, frame: 150 });
    expect(snapTimelineEdges([100, 148], [97, 150], 1, TIMELINE_SNAP_PX)).toEqual({ shift: 2, frame: 150 });
    expect(snapTimelineEdges([100, 148], [99, 150], 1, TIMELINE_SNAP_PX)).toEqual({ shift: -1, frame: 99 });
  });

  it('answers a zero shift for an edge already on a target', () => {
    expect(snapTimelineEdges([48], [48, 50], 1, TIMELINE_SNAP_PX)).toEqual({ shift: 0, frame: 48 });
  });

  it('returns null without targets', () => {
    expect(snapTimelineEdges([100, 148], [], 1, TIMELINE_SNAP_PX)).toBe(null);
  });

  it('never shifts further than the threshold and always lands an edge on a target', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 2 }),
      fc.array(fc.integer({ min: 0, max: 2000 }), { maxLength: 6 }),
      fc.constantFrom(0.25, 0.5, 1, 2, 4),
      (edges, targets, ppf) => {
        const result = snapTimelineEdges(edges, targets, ppf, TIMELINE_SNAP_PX);
        const best = Math.min(...edges.flatMap((edge) => targets.map((target) => Math.abs(target - edge))));
        if (result === null) {
          expect(targets.length === 0 || best * ppf > TIMELINE_SNAP_PX).toBe(true);
          return;
        }
        expect(Math.abs(result.shift) * ppf).toBeLessThanOrEqual(TIMELINE_SNAP_PX);
        expect(Math.abs(result.shift)).toBe(best);
        expect(targets).toContain(result.frame);
        expect(edges.map((edge) => edge + result.shift)).toContain(result.frame);
      },
    ));
  });
});

describe('timelineSnapTargets', () => {
  it('lists other clip edges on every track, the playhead and frame 0, once each', () => {
    const document = timeline([
      clip(cid(1), MAIN, 0, 48),
      clip(cid(2), MAIN, 48, 24),
      clip(cid(3), 'v2', 30, 18),
      clip(cid(4), 'v2', 200, 10),
    ]);
    const targets = timelineSnapTargets(document, cid(4), 72);
    expect([...targets].sort((a, b) => a - b)).toEqual([0, 30, 48, 72]);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('includes the playhead and excludes only the dragged clip', () => {
    const document = timeline([clip(cid(1), MAIN, 10, 20), clip(cid(2), 'v2', 100, 50)]);
    expect([...timelineSnapTargets(document, cid(1), 333)].sort((a, b) => a - b)).toEqual([0, 100, 150, 333]);
    expect([...timelineSnapTargets(document, cid(2), 0)].sort((a, b) => a - b)).toEqual([0, 10, 30]);
  });
});
