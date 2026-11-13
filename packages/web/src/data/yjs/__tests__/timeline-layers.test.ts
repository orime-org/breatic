// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import { nextTimelinePlaybackBoundary, visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';
import { orderedTimelineTracks, timelineTrackRank } from '@web/data/yjs/timeline-order';
import type { TimelineClip } from '@breatic/shared';
import { MAIN, V2, V3, cid, clip, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

const LOW = cid(1);
const TOP = cid(2);
const layered = timeline([clip(LOW, MAIN, 0, 480), clip(TOP, V2, 100, 48)]);
const allReady = new Set([LOW, TOP]);

/**
 * The ids visible at a frame, bottom-up.
 * @param document - The document.
 * @param ready - The ready clips.
 * @param frame - The frame.
 * @returns The ids.
 * @throws {never} Never.
 */
function visibleIds(document: Parameters<typeof visibleTimelineClipsAt>[0], ready: ReadonlySet<string>, frame: number): string[] {
  return visibleTimelineClipsAt(document, ready, frame).map((item) => item.id);
}

// Every ready clip covering the frame is drawn, bottom-up; an upper video no longer hides what is under it (breatic#1410 design §6.1).
describe('visibleTimelineClipsAt stacks every ready clip', () => {
  it('keeps the lower clip under the upper one while the upper clip covers the frame', () => {
    expect(visibleIds(layered, allReady, 99)).toEqual([LOW]);
    expect(visibleIds(layered, allReady, 100)).toEqual([LOW, TOP]);
    expect(visibleIds(layered, allReady, 147)).toEqual([LOW, TOP]);
    expect(visibleIds(layered, allReady, 148)).toEqual([LOW]);
    expect(visibleTimelineClipsAt(layered, allReady, 120)).toEqual([layered.clips[LOW], layered.clips[TOP]]);
  });

  it('leaves out a clip that is not ready, and shows nothing in a gap, past the end or with nothing ready', () => {
    expect(visibleIds(layered, new Set([LOW]), 120)).toEqual([LOW]);
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(visibleIds(gapped, allReady, 15)).toEqual([]);
    expect(visibleIds(gapped, allReady, 30)).toEqual([]);
    expect(visibleIds(layered, new Set(), 120)).toEqual([]);
  });

  it('orders clips on tracks sharing an order by the ordered tracks', () => {
    const tied = timeline([clip(TOP, V2, 0, 10), clip(LOW, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    expect(visibleIds(tied, allReady, 5)).toEqual([TOP, LOW]);
  });
});

describe('nextTimelinePlaybackBoundary', () => {
  it('stops at every ready clip start strictly after the frame, and not where a video ends', () => {
    expect(nextTimelinePlaybackBoundary(layered, allReady, 90, 480)).toBe(100);
    expect(nextTimelinePlaybackBoundary(layered, allReady, 100, 480)).toBe(480);
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

describe('nextTimelinePlaybackBoundary under an upper layer (breatic#1410 design §6.1)', () => {
  it('stops at a lower clip edge under an upper clip', () => {
    const M1 = cid(11);
    const M2 = cid(12);
    const UPPER = cid(13);
    const hidden = timeline([clip(M1, MAIN, 0, 48), clip(M2, MAIN, 48, 192), clip(UPPER, V2, 0, 240)], [track(MAIN, 0), track(V2, 1)]);
    const ready = new Set([M1, M2, UPPER]);
    expect(visibleIds(hidden, ready, 47)).toEqual([M1, UPPER]);
    expect(visibleIds(hidden, ready, 48)).toEqual([M2, UPPER]);
    expect(nextTimelinePlaybackBoundary(hidden, ready, 0, 240)).toBe(48);
    expect(nextTimelinePlaybackBoundary(hidden, ready, 48, 240)).toBe(240);
  });

  it('returns the next ready clip start or end of a web copy showing at the frame; in between nothing appears and no showing copy leaves', () => {
    const seed = fc.record({
      layer: fc.integer({ min: 0, max: 2 }),
      startFrame: fc.integer({ min: 0, max: 60 }),
      durationFrames: fc.integer({ min: 1, max: 40 }),
      ready: fc.boolean(),
      web: fc.boolean(),
    });
    // V3's order is drawn from 1 or 2, so V2 and V3 sometimes tie (inner#1708 E3).
    fc.assert(fc.property(fc.array(seed, { maxLength: 6 }), fc.integer({ min: 0, max: 100 }), fc.constantFrom(1, 2), (seeds, frame, v3Order) => {
      const layers = [MAIN, V2, V3];
      const clips: TimelineClip[] = seeds.map((item, index) => (item.web ? webClip : clip)(cid(index + 1), layers[item.layer] ?? MAIN, item.startFrame, item.durationFrames));
      const document = timeline(clips, [track(MAIN, 0), track(V2, 1), track(V3, v3Order)]);
      const ready = new Set(clips.filter((_item, index) => seeds[index]?.ready === true).map((item) => item.id));
      const end = 110;
      // Reference model, independent of the code under test: every ready clip covering the frame, as a set.
      const covering = (at: number): string[] => clips.filter((item) => ready.has(item.id) && item.startFrame <= at && at < item.startFrame + item.durationFrames)
        .map((item) => item.id).sort();
      const shown = (at: number): string[] => visibleIds(document, ready, at).slice().sort();
      const readyClips = clips.filter((item) => ready.has(item.id));
      const startsAt = (at: number): boolean => readyClips.some((item) => item.startFrame === at);
      // The web copies showing at the frame: a video's end is not a boundary, a showing web copy's end is.
      const showingWeb = readyClips.filter((item) => item.kind === 'web-animation' && item.startFrame <= frame && frame < item.startFrame + item.durationFrames);
      const webEndsAt = (at: number): boolean => showingWeb.some((item) => item.startFrame + item.durationFrames === at);
      const next = nextTimelinePlaybackBoundary(document, ready, frame, end);
      expect(shown(frame)).toEqual(covering(frame));
      expect(next).toBeGreaterThan(frame);
      for (let at = frame + 1; at < next; at += 1) {
        expect(startsAt(at) || webEndsAt(at), `a boundary at ${at} before ${next}`).toBe(false);
        // Only videos may leave before the boundary: nothing appears, and every showing web copy stays.
        for (const id of shown(at)) expect(shown(frame), `${id} appeared at ${at} before ${next}`).toContain(id);
        for (const item of showingWeb) expect(shown(at)).toContain(item.id);
      }
      if (next < end) expect(startsAt(next) || webEndsAt(next), `nothing starts or ends at ${next}`).toBe(true);
    }), { numRuns: 300 });
  });
});

describe('nextTimelinePlaybackBoundary cost (inner#1708 D5)', () => {
  it('answers 60 calls over 1000 covered main clips in under 60 ms', () => {
    const clips: TimelineClip[] = Array.from({ length: 1000 }, (_item, index) => clip(cid(index + 2), MAIN, index * 2, 2));
    const cover = clip(cid(1), V2, 0, 2000);
    const document = timeline([...clips, cover], [track(MAIN, 0), track(V2, 1)]);
    const ready = new Set([cover.id, ...clips.map((item) => item.id)]);
    // Warm the code paths so the measurement is not dominated by compilation. The next main clip's start counts.
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 2010)).toBe(2);
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

  it('stacks the clip on the later of two tied tracks on top, whatever the clip ids', () => {
    // V3 comes after V2 in the ordered tracks; the clip on V3 has the larger id.
    const onLower = cid(1);
    const onUpper = cid(2);
    const tied = timeline([clip(onLower, V2, 0, 10), clip(onUpper, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    const ready = new Set([onLower, onUpper]);
    expect(orderedTimelineTracks(tied.tracks).map((item) => item.id)).toEqual([MAIN, V2, V3]);
    expect(visibleIds(tied, ready, 5)).toEqual([onLower, onUpper]);
  });

  it('finds the boundary where a web copy on the upper tied track ends over a longer lower one, and none where a video there ends', () => {
    const onLower = cid(1);
    const onUpper = cid(2);
    const tracks = [track(MAIN, 0), track(V2, 1), track(V3, 1)];
    const ready = new Set([onLower, onUpper]);
    const tiedWeb = timeline([clip(onLower, V2, 0, 40), webClip(onUpper, V3, 0, 10)], tracks);
    expect(nextTimelinePlaybackBoundary(tiedWeb, ready, 0, 50)).toBe(10);
    expect(visibleIds(tiedWeb, ready, 10)).toEqual([onLower]);
    const tiedVideo = timeline([clip(onLower, V2, 0, 40), clip(onUpper, V3, 0, 10)], tracks);
    expect(nextTimelinePlaybackBoundary(tiedVideo, ready, 0, 50)).toBe(50);
  });
});

describe('a clip whose source is missing (inner#1708 M1)', () => {
  it('is not shown; the clip below it is', () => {
    const below = cid(1);
    const above = cid(2);
    const document = timeline([clip(below, MAIN, 0, 48), clip(above, V2, 10, 20, { sourceId: '10000000-0000-4000-8000-0000000000ff' })]);
    const ready = new Set(resolveTimelineArrangement(document).readyClipIds);
    expect(ready.has(above)).toBe(false);
    expect(visibleIds(document, ready, 15)).toEqual([below]);
    // The video below ends at 48, which is no boundary; the clip above is not ready, so its start is none either.
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 60)).toBe(60);
  });
});
