// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import { activeTimelineClipAt, nextTimelinePlaybackBoundary } from '@web/data/yjs/timeline-layers';
import { orderedTimelineTracks, timelineTrackRank } from '@web/data/yjs/timeline-order';
import type { TimelineVideoClip } from '@breatic/shared';
import { MAIN, V2, V3, cid, clip, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';

const LOW = cid(1);
const TOP = cid(2);
const layered = timeline([clip(LOW, MAIN, 0, 480), clip(TOP, V2, 100, 48)]);
const allReady = new Set([LOW, TOP]);

describe('activeTimelineClipAt', () => {
  it('shows the highest-order ready clip and switches at the upper clip\'s start and end', () => {
    expect(activeTimelineClipAt(layered, allReady, 99)?.id).toBe(LOW);
    expect(activeTimelineClipAt(layered, allReady, 100)?.id).toBe(TOP);
    expect(activeTimelineClipAt(layered, allReady, 147)?.id).toBe(TOP);
    expect(activeTimelineClipAt(layered, allReady, 148)?.id).toBe(LOW);
    expect(activeTimelineClipAt(layered, allReady, 120)).toEqual(layered.clips[TOP]);
  });

  it('falls back to the lower clip when the upper clip is not ready', () => {
    expect(activeTimelineClipAt(layered, new Set([LOW]), 120)?.id).toBe(LOW);
  });

  it('returns null in a gap, past the end and when nothing is ready', () => {
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(activeTimelineClipAt(gapped, allReady, 15)).toBeNull();
    expect(activeTimelineClipAt(gapped, allReady, 30)).toBeNull();
    expect(activeTimelineClipAt(layered, new Set(), 120)).toBeNull();
  });

  it('breaks a tie between equal track orders by clip id', () => {
    const tied = timeline([clip(TOP, V2, 0, 10), clip(LOW, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    expect(activeTimelineClipAt(tied, allReady, 5)?.id).toBe(LOW);
  });
});

describe('nextTimelinePlaybackBoundary', () => {
  it('stops at every ready clip start and end strictly after the frame', () => {
    expect(nextTimelinePlaybackBoundary(layered, allReady, 90, 480)).toBe(100);
    expect(nextTimelinePlaybackBoundary(layered, allReady, 100, 480)).toBe(148);
    expect(nextTimelinePlaybackBoundary(layered, allReady, 148, 480)).toBe(480);
  });

  it('ignores clips that are not ready', () => {
    expect(nextTimelinePlaybackBoundary(layered, new Set([LOW]), 90, 480)).toBe(480);
  });

  it('crosses a gap to the next clip start', () => {
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(nextTimelinePlaybackBoundary(gapped, allReady, 10, 30)).toBe(20);
  });

  it('is capped by the end frame', () => {
    expect(nextTimelinePlaybackBoundary(layered, allReady, 100, 120)).toBe(120);
    expect(nextTimelinePlaybackBoundary(layered, new Set(), 0, 480)).toBe(480);
  });
});

describe('nextTimelinePlaybackBoundary under an upper layer (inner#1708 C2)', () => {
  it('skips a lower clip edge hidden under an upper clip', () => {
    const M1 = cid(11);
    const M2 = cid(12);
    const UPPER = cid(13);
    const hidden = timeline([clip(M1, MAIN, 0, 48), clip(M2, MAIN, 48, 192), clip(UPPER, V2, 0, 240)], [track(MAIN, 0), track(V2, 1)]);
    const ready = new Set([M1, M2, UPPER]);
    expect(activeTimelineClipAt(hidden, ready, 47)?.id).toBe(UPPER);
    expect(activeTimelineClipAt(hidden, ready, 48)?.id).toBe(UPPER);
    expect(nextTimelinePlaybackBoundary(hidden, ready, 0, 240)).toBe(240);
  });

  it('returns exactly the next frame where the shown clip changes', () => {
    const seed = fc.record({
      layer: fc.integer({ min: 0, max: 2 }),
      startFrame: fc.integer({ min: 0, max: 60 }),
      durationFrames: fc.integer({ min: 1, max: 40 }),
      ready: fc.boolean(),
    });
    // V3's order is drawn from 1 or 2, so V2 and V3 sometimes tie (inner#1708 E3).
    fc.assert(fc.property(fc.array(seed, { maxLength: 6 }), fc.integer({ min: 0, max: 100 }), fc.constantFrom(1, 2), (seeds, frame, v3Order) => {
      const layers = [MAIN, V2, V3];
      const clips: TimelineVideoClip[] = seeds.map((item, index) => clip(cid(index + 1), layers[item.layer] ?? MAIN, item.startFrame, item.durationFrames));
      const document = timeline(clips, [track(MAIN, 0), track(V2, 1), track(V3, v3Order)]);
      const ready = new Set(clips.filter((_item, index) => seeds[index]?.ready === true).map((item) => item.id));
      const end = 110;
      const shown = (at: number): string | null => activeTimelineClipAt(document, ready, at)?.id ?? null;
      const next = nextTimelinePlaybackBoundary(document, ready, frame, end);
      expect(next).toBeGreaterThan(frame);
      for (let at = frame + 1; at < next; at += 1) expect(shown(at), `shown clip changed at ${at} before ${next}`).toBe(shown(frame));
      if (next < end) expect(shown(next), `nothing changes at ${next}`).not.toBe(shown(next - 1));
    }), { numRuns: 300 });
  });
});

describe('nextTimelinePlaybackBoundary cost (inner#1708 D5)', () => {
  it('answers 60 calls over 1000 covered main clips in under 60 ms', () => {
    const clips: TimelineVideoClip[] = Array.from({ length: 1000 }, (_item, index) => clip(cid(index + 2), MAIN, index * 2, 2));
    const cover = clip(cid(1), V2, 0, 2000);
    const document = timeline([...clips, cover], [track(MAIN, 0), track(V2, 1)]);
    const ready = new Set([cover.id, ...clips.map((item) => item.id)]);
    // Warm the code paths so the measurement is not dominated by compilation.
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 2010)).toBe(2000);
    const started = performance.now();
    for (let call = 0; call < 60; call += 1) nextTimelinePlaybackBoundary(document, ready, 0, 2010);
    expect(performance.now() - started).toBeLessThan(60);
  });
});

describe('tracks sharing an order (inner#1708 E3)', () => {
  it('ranks every track by its place in the ordered tracks', () => {
    const tracks = { [MAIN]: track(MAIN, 0), b: track('b', 1), a: track('a', 1), c: track('c', 5) };
    const rank = timelineTrackRank(tracks);
    expect([...rank.entries()].sort((x, y) => x[1] - y[1])).toEqual([[MAIN, 0], ['a', 1], ['b', 2], ['c', 3]]);
    expect(orderedTimelineTracks(tracks).map((item) => rank.get(item.id))).toEqual([0, 1, 2, 3]);
  });

  it('shows the clip on the later of two tied tracks, whatever the clip ids', () => {
    // V3 comes after V2 in the ordered tracks; the clip on V3 has the larger id.
    const onLower = cid(1);
    const onUpper = cid(2);
    const tied = timeline([clip(onLower, V2, 0, 10), clip(onUpper, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    const ready = new Set([onLower, onUpper]);
    expect(orderedTimelineTracks(tied.tracks).map((item) => item.id)).toEqual([MAIN, V2, V3]);
    expect(activeTimelineClipAt(tied, ready, 5)?.id).toBe(onUpper);
  });

  it('finds the boundary where the upper tied track\'s clip ends over a longer lower one', () => {
    const onLower = cid(1);
    const onUpper = cid(2);
    const tied = timeline([clip(onLower, V2, 0, 40), clip(onUpper, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    const ready = new Set([onLower, onUpper]);
    expect(nextTimelinePlaybackBoundary(tied, ready, 0, 50)).toBe(10);
    expect(activeTimelineClipAt(tied, ready, 10)?.id).toBe(onLower);
  });
});

describe('a clip whose source is missing (inner#1708 M1)', () => {
  it('is not shown; the clip below it is', () => {
    const below = cid(1);
    const above = cid(2);
    const document = timeline([clip(below, MAIN, 0, 48), clip(above, V2, 10, 20, { sourceId: '10000000-0000-4000-8000-0000000000ff' })]);
    const ready = new Set(resolveTimelineArrangement(document).readyClipIds);
    expect(ready.has(above)).toBe(false);
    expect(activeTimelineClipAt(document, ready, 15)?.id).toBe(below);
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 60)).toBe(48);
  });
});
