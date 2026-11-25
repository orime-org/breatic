// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Layers and lanes at a frame (breatic#1410 design §6.1, inner#1709 design §2.4, §3.5).
 *
 * Every function here reads the view document: its clips are the ones `arrangeTimelineClips` keeps, each at the length
 * it plays. `visibleTimelineClipsAt(document, frame)` is, bottom-up by track, the one clip per track that is drawn at the
 * frame (every kind but sound); `audibleTimelineClipsAt(document, frame)` is the one video or sound clip per track
 * heard at the frame; on a track where clips overlap, the one starting later covers the other.
 * `nextTimelinePlaybackBoundary(document, frame, endFrame)` stops where a clip starts, where a shown web copy, picture
 * or text ends, and where a covered clip comes back into view.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';

import { arrangeTimelineClips } from '@web/data/yjs/timeline-arrangement';
import { audibleTimelineClipsAt, nextTimelinePlaybackBoundary, visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';
import { orderedTimelineTracks, timelineTrackRank } from '@web/data/yjs/timeline-order';
import { MAIN, SOURCE, V2, V3, cid, clip, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  AUDIO, IMAGE, audioClip, imageClip, mixedTimeline, textClip, type MediaClip,
} from '@web/data/yjs/__tests__/timeline-media-fixtures';
import { EMPTY_RESOLUTION, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

const LOW = cid(1);
const TOP = cid(2);
const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2)];
const layered = timeline([clip(LOW, MAIN, 0, 480), clip(TOP, V2, 100, 48)]);

/**
 * A view document of any clips on main, v2 and v3.
 * @param clips - The clips.
 * @returns The document.
 * @throws {never} Never.
 */
function view(clips: readonly MediaClip[]): TimelineDocumentV1 {
  return mixedTimeline(clips, TRACKS, [SOURCE, IMAGE, AUDIO]);
}

/**
 * The ids visible at a frame, bottom-up.
 * @param document - The view document.
 * @param frame - The frame.
 * @returns The ids.
 * @throws {never} Never.
 */
function visibleIds(document: TimelineDocumentV1, frame: number): string[] {
  return visibleTimelineClipsAt(document, frame).map((item) => item.id);
}

/**
 * The ids heard at a frame, sorted.
 * @param document - The view document.
 * @param frame - The frame.
 * @returns The ids.
 * @throws {never} Never.
 */
function audibleIds(document: TimelineDocumentV1, frame: number): string[] {
  return audibleTimelineClipsAt(document, frame).map((item) => item.id).sort();
}

describe('visibleTimelineClipsAt stacks one drawn clip per track (breatic#1410, inner#1709)', () => {
  it('keeps the lower clip under the upper one while the upper clip covers the frame', () => {
    expect(visibleIds(layered, 99)).toEqual([LOW]);
    expect(visibleIds(layered, 100)).toEqual([LOW, TOP]);
    expect(visibleIds(layered, 147)).toEqual([LOW, TOP]);
    expect(visibleIds(layered, 148)).toEqual([LOW]);
    expect(visibleTimelineClipsAt(layered, 120)).toEqual([layered.clips[LOW], layered.clips[TOP]]);
  });

  it('shows nothing in a gap or past the end', () => {
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(visibleIds(gapped, 15)).toEqual([]);
    expect(visibleIds(gapped, 30)).toEqual([]);
  });

  it('orders clips on tracks sharing an order by the ordered tracks', () => {
    const tied = timeline([clip(TOP, V2, 0, 10), clip(LOW, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    expect(visibleIds(tied, 5)).toEqual([TOP, LOW]);
  });

  it('draws pictures and texts on any track and never draws a sound clip', () => {
    const document = view([clip(cid(1), MAIN, 0, 48), audioClip(cid(2), V2, 0, 48), imageClip(cid(3), V3, 0, 48), textClip(cid(4), MAIN, 48, 48)]);
    expect(visibleIds(document, 10)).toEqual([cid(1), cid(3)]);
    expect(visibleIds(document, 50)).toEqual([cid(4)]);
  });

  it('draws only the later-starting of two overlapping clips on one track', () => {
    const document = view([clip(cid(2), V2, 0, 100), imageClip(cid(1), V2, 40, 20), clip(cid(3), MAIN, 0, 100)]);
    expect(visibleIds(document, 39)).toEqual([cid(3), cid(2)]);
    expect(visibleIds(document, 40)).toEqual([cid(3), cid(1)]);
    expect(visibleIds(document, 60)).toEqual([cid(3), cid(2)]);
  });
});

describe('audibleTimelineClipsAt (inner#1709 design §2.4)', () => {
  it('hears every video and sound clip on any track, and no picture, text or web copy', () => {
    const document = view([
      clip(cid(1), MAIN, 0, 48), audioClip(cid(2), V2, 0, 48), audioClip(cid(3), V3, 0, 100),
      imageClip(cid(4), MAIN, 48, 48), textClip(cid(5), V2, 48, 48), webClip(cid(6), V3, 100, 48),
    ]);
    expect(audibleIds(document, 10)).toEqual([cid(1), cid(2), cid(3)].sort());
    expect(audibleIds(document, 50)).toEqual([cid(3)]);
    expect(audibleIds(document, 110)).toEqual([]);
  });

  it('hears only the later-starting of two overlapping video or sound clips on one track', () => {
    const document = view([audioClip(cid(2), V2, 0, 100), clip(cid(1), V2, 30, 20)]);
    expect(audibleIds(document, 29)).toEqual([cid(2)]);
    expect(audibleIds(document, 30)).toEqual([cid(1)]);
    expect(audibleIds(document, 50)).toEqual([cid(2)]);
  });
});

describe('nextTimelinePlaybackBoundary', () => {
  it('stops at every clip start strictly after the frame, and not where a video ends', () => {
    expect(nextTimelinePlaybackBoundary(layered, 90, 480)).toBe(100);
    expect(nextTimelinePlaybackBoundary(layered, 100, 480)).toBe(480);
    expect(nextTimelinePlaybackBoundary(layered, 148, 480)).toBe(480);
  });

  it('crosses a gap to the next clip start', () => {
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(nextTimelinePlaybackBoundary(gapped, 10, 30)).toBe(20);
  });

  it('is capped by the end frame', () => {
    expect(nextTimelinePlaybackBoundary(layered, 100, 120)).toBe(120);
    expect(nextTimelinePlaybackBoundary(timeline([]), 0, 480)).toBe(480);
  });

  it('stops where a shown picture or text ends, since the frame changes there (inner#1709 design §2.4)', () => {
    const document = view([clip(cid(1), MAIN, 0, 200), imageClip(cid(2), V2, 0, 48), textClip(cid(3), V3, 10, 60)]);
    expect(nextTimelinePlaybackBoundary(document, 0, 200)).toBe(10);
    expect(nextTimelinePlaybackBoundary(document, 10, 200)).toBe(48);
    expect(nextTimelinePlaybackBoundary(document, 48, 200)).toBe(70);
    expect(nextTimelinePlaybackBoundary(document, 70, 200)).toBe(200);
  });

  it('stops where a sound clip starts but not where it ends', () => {
    const document = view([clip(cid(1), MAIN, 0, 200), audioClip(cid(2), V2, 30, 40)]);
    expect(nextTimelinePlaybackBoundary(document, 0, 200)).toBe(30);
    expect(nextTimelinePlaybackBoundary(document, 30, 200)).toBe(200);
  });

  it('stops where a covered clip comes back into view as the clip over it on its track ends', () => {
    const document = view([clip(cid(2), V2, 0, 100), clip(cid(1), V2, 40, 20)]);
    expect(nextTimelinePlaybackBoundary(document, 40, 100)).toBe(60);
  });

  it('stops at a lower clip edge under an upper clip', () => {
    const M1 = cid(11);
    const M2 = cid(12);
    const UPPER = cid(13);
    const hidden = timeline([clip(M1, MAIN, 0, 48), clip(M2, MAIN, 48, 192), clip(UPPER, V2, 0, 240)], [track(MAIN, 0), track(V2, 1)]);
    expect(visibleIds(hidden, 47)).toEqual([M1, UPPER]);
    expect(visibleIds(hidden, 48)).toEqual([M2, UPPER]);
    expect(nextTimelinePlaybackBoundary(hidden, 0, 240)).toBe(48);
    expect(nextTimelinePlaybackBoundary(hidden, 48, 240)).toBe(240);
  });

  it('lets nothing appear, be heard anew, or a shown web copy, picture or text leave before the next boundary, for overlapping mixed clips (fast-check)', () => {
    const seed = fc.record({
      layer: fc.integer({ min: 0, max: 2 }),
      startFrame: fc.integer({ min: 0, max: 60 }),
      durationFrames: fc.integer({ min: 1, max: 40 }),
      kind: fc.constantFrom('video', 'web', 'image', 'text', 'audio'),
    });
    fc.assert(fc.property(fc.array(seed, { maxLength: 7 }), fc.integer({ min: 0, max: 100 }), fc.constantFrom(1, 2), (seeds, frame, v3Order) => {
      const layers = [MAIN, V2, V3];
      // One start per track and frame, so the reference needs no tie rule.
      const unique = seeds.filter((item, index) => seeds.findIndex((other) => other.layer === item.layer && other.startFrame === item.startFrame) === index);
      const clips: MediaClip[] = unique.map((item, index) => {
        const build = { video: clip, web: webClip, image: imageClip, text: textClip, audio: audioClip }[item.kind];
        return build(cid(index + 1), layers[item.layer] ?? MAIN, item.startFrame, item.durationFrames);
      });
      const document = mixedTimeline(clips, [track(MAIN, 0), track(V2, 1), track(V3, v3Order)], [SOURCE, IMAGE, AUDIO]);
      const end = 110;
      // Reference model, independent of the code under test: per track, the latest-starting covering clip.
      const top = (at: number, keep: (item: MediaClip) => boolean): string[] => layers.flatMap((trackId) => {
        const covering = clips.filter((item) => keep(item) && item.trackId === trackId && item.startFrame <= at && at < item.startFrame + item.durationFrames);
        const latest = covering.sort((a, b) => b.startFrame - a.startFrame)[0];
        return latest === undefined ? [] : [latest.id];
      }).sort();
      const drawn = (at: number): string[] => top(at, (item) => item.kind !== 'audio');
      const heard = (at: number): string[] => top(at, (item) => item.kind === 'video' || item.kind === 'audio');
      const ending = clips.filter((item) => item.kind === 'web-animation' || item.kind === 'image' || item.kind === 'text');
      const next = nextTimelinePlaybackBoundary(document, frame, end);
      expect(visibleIds(document, frame).slice().sort()).toEqual(drawn(frame));
      expect(audibleIds(document, frame)).toEqual(heard(frame));
      expect(next).toBeGreaterThan(frame);
      const shownEnding = ending.filter((item) => drawn(frame).includes(item.id));
      for (let at = frame + 1; at < next; at += 1) {
        for (const id of drawn(at)) expect(drawn(frame), `${id} appeared at ${at} before ${next}`).toContain(id);
        for (const id of heard(at)) expect(heard(frame), `${id} was heard at ${at} before ${next}`).toContain(id);
        for (const item of shownEnding) expect(drawn(at), `${item.id} left at ${at} before ${next}`).toContain(item.id);
      }
    }), { numRuns: 300 });
  });
});

describe('nextTimelinePlaybackBoundary cost (inner#1708 D5)', () => {
  it('answers 60 calls over 1000 covered main clips in under 60 ms', () => {
    const clips: TimelineClip[] = Array.from({ length: 1000 }, (_item, index) => clip(cid(index + 2), MAIN, index * 2, 2));
    const cover = clip(cid(1), V2, 0, 2000);
    const document = timeline([...clips, cover], [track(MAIN, 0), track(V2, 1)]);
    // Warm the code paths so the measurement is not dominated by compilation. The next main clip's start counts.
    expect(nextTimelinePlaybackBoundary(document, 0, 2010)).toBe(2);
    const started = performance.now();
    for (let call = 0; call < 60; call += 1) nextTimelinePlaybackBoundary(document, 0, 2010);
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
    expect(orderedTimelineTracks(tied.tracks).map((item) => item.id)).toEqual([MAIN, V2, V3]);
    expect(visibleIds(tied, 5)).toEqual([onLower, onUpper]);
  });

  it('finds the boundary where a web copy on the upper tied track ends over a longer lower one, and none where a video there ends', () => {
    const onLower = cid(1);
    const onUpper = cid(2);
    const tracks = [track(MAIN, 0), track(V2, 1), track(V3, 1)];
    const tiedWeb = timeline([clip(onLower, V2, 0, 40), webClip(onUpper, V3, 0, 10)], tracks);
    expect(nextTimelinePlaybackBoundary(tiedWeb, 0, 50)).toBe(10);
    expect(visibleIds(tiedWeb, 10)).toEqual([onLower]);
    const tiedVideo = timeline([clip(onLower, V2, 0, 40), clip(onUpper, V3, 0, 10)], tracks);
    expect(nextTimelinePlaybackBoundary(tiedVideo, 0, 50)).toBe(50);
  });
});

describe('the view document leaves out a clip whose source is missing (inner#1709 design §3.5)', () => {
  it('draws the clip below it and finds no boundary at its start', () => {
    const below = cid(1);
    const above = cid(2);
    const raw = timeline([clip(below, MAIN, 0, 48), clip(above, V2, 10, 20, { sourceId: '10000000-0000-4000-8000-0000000000ff' })]);
    const document = { ...raw, clips: arrangeTimelineClips(raw, EMPTY_RESOLUTION) };
    expect(document.clips[above]).toBeUndefined();
    expect(visibleIds(document, 15)).toEqual([below]);
    // The video below ends at 48, which is no boundary; the clip above is not in the view, so its start is none either.
    expect(nextTimelinePlaybackBoundary(document, 0, 60)).toBe(60);
  });
});
