// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The clip view (inner#1709 design §2.4, §3.5): `arrangeTimelineClips(document, web)` answers only how each clip
 * plays. It keeps the clips that can be shown (their track exists and they need no source, or their source record is
 * there and of their kind), cuts a clip longer than its source to the frames the source holds, and
 * `pickTimelineClipAt(clips, trackId, frame)` gives the one clip of a track that plays at a frame: of several covering
 * it, the one starting last, ties broken by id. There are no conflicts any more.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { TimelineClip, TimelineDocumentV1, TimelineVideoSource } from '@breatic/shared';

import {
  arrangeTimelineClips, pickTimelineClipAt, resolveTimelineClipExtent, timelineClipSource,
} from '@web/data/yjs/timeline-arrangement';
import { FPS, MAIN, SHORT_SOURCE, SOURCE, V2, V3, cid, clip } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  AUDIO, IMAGE, audioClip, imageClip, mediaUpload, mixedTimeline, plainTrack, textClip,
} from '@web/data/yjs/__tests__/timeline-media-fixtures';
import { EMPTY_RESOLUTION, EXEC_GONE, RESOLUTION, SRC_A, waitingFor, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

const TRACKS = [plainTrack(MAIN, 0), plainTrack(V2, 1), plainTrack(V3, 2)];
const UNBOUNDED = { timebase: FPS, extentFrames: Number.MAX_SAFE_INTEGER };

describe('resolveTimelineClipExtent for every kind (design §2.4)', () => {
  const document = mixedTimeline([], TRACKS);

  it('reads a sound clip\'s source like a video\'s', () => {
    expect(resolveTimelineClipExtent(document, EMPTY_RESOLUTION, audioClip(cid(1), V2, 0, 10) as unknown as TimelineClip)).toEqual(AUDIO);
    expect(resolveTimelineClipExtent(document, EMPTY_RESOLUTION, clip(cid(2), V2, 0, 10))).toEqual(SOURCE);
  });

  it('gives a picture, a text and a picture placeholder no upper bound', () => {
    for (const item of [imageClip(cid(1), V2, 0, 10), textClip(cid(2), V2, 0, 10), mediaUpload(cid(3), V2, 0, 10, 'image')]) {
      expect(resolveTimelineClipExtent(document, EMPTY_RESOLUTION, item as unknown as TimelineClip), item.kind).toEqual(UNBOUNDED);
    }
  });

  it('measures a sound placeholder by the duration the browser read', () => {
    // 2.5 s at 24 fps is 60 frames.
    expect(resolveTimelineClipExtent(document, EMPTY_RESOLUTION, mediaUpload(cid(1), V2, 0, 10, 'audio') as unknown as TimelineClip))
      .toMatchObject({ timebase: FPS, extentFrames: 60 });
  });

  it('has no extent for a picture or sound whose source record is missing', () => {
    const bare = mixedTimeline([], TRACKS, [SOURCE]);
    expect(resolveTimelineClipExtent(bare, EMPTY_RESOLUTION, audioClip(cid(1), V2, 0, 10) as unknown as TimelineClip)).toBeUndefined();
  });
});

describe('timelineClipSource (design §2.4)', () => {
  it('returns the video, picture or sound source a clip shows, and none for text, web or upload clips', () => {
    const sources = { [SOURCE.id]: SOURCE, [IMAGE.id]: IMAGE, [AUDIO.id]: AUDIO } as unknown as Record<string, TimelineVideoSource>;
    expect(timelineClipSource(sources, clip(cid(1), V2, 0, 10))).toEqual(SOURCE);
    expect(timelineClipSource(sources, imageClip(cid(2), V2, 0, 10) as unknown as TimelineClip)).toEqual(IMAGE);
    expect(timelineClipSource(sources, audioClip(cid(3), V2, 0, 10) as unknown as TimelineClip)).toEqual(AUDIO);
    expect(timelineClipSource(sources, textClip(cid(4), V2, 0, 10) as unknown as TimelineClip)).toBeUndefined();
    expect(timelineClipSource(sources, webClip(cid(5), V2, 0, 10))).toBeUndefined();
  });
});

describe('arrangeTimelineClips keeps only the clips that can be shown (design §3.5)', () => {
  it('keeps every kind whose track exists and whose source, if it needs one, is there and of its kind', () => {
    const shown = [
      clip(cid(1), MAIN, 0, 48), imageClip(cid(2), V2, 0, 48), audioClip(cid(3), V3, 0, 48), textClip(cid(4), V2, 48, 48),
      webClip(cid(5), V3, 48, 48), mediaUpload(cid(6), V3, 200, 60, 'video'),
    ];
    const view = arrangeTimelineClips(mixedTimeline(shown, TRACKS), RESOLUTION);
    expect(Object.keys(view).sort()).toEqual(shown.map((item) => item.id).sort());
    for (const item of shown) expect(view[item.id]).toEqual(item);
  });

  it('leaves out a clip on a removed track, one whose source record is missing and one whose source is of another kind', () => {
    const kept = clip(cid(1), MAIN, 0, 48);
    const view = arrangeTimelineClips(mixedTimeline([
      kept,
      clip(cid(2), 'gone', 0, 48),
      imageClip(cid(3), V2, 0, 48, { sourceId: '10000000-0000-4000-8000-0000000000ff' }),
      audioClip(cid(4), V3, 0, 48, { sourceId: IMAGE.id }),
      imageClip(cid(5), V2, 100, 48, { sourceId: AUDIO.id }),
    ], TRACKS), EMPTY_RESOLUTION);
    expect(view).toEqual({ [kept.id]: kept });
  });

  it('returns an empty table for an empty document', () => {
    expect(arrangeTimelineClips(mixedTimeline([], TRACKS), EMPTY_RESOLUTION)).toEqual({});
  });
});

describe('arrangeTimelineClips plays a clip longer than its source to the source\'s end (design §2.4)', () => {
  it('cuts a video and a sound longer than their files to the frames the files hold', () => {
    const long = clip(cid(1), MAIN, 0, 80, { sourceId: SHORT_SOURCE.id });
    const lateIn = clip(cid(2), V2, 0, 48, { sourceId: SHORT_SOURCE.id, sourceInFrame: 40 });
    const sound = audioClip(cid(3), V3, 10, 200);
    const view = arrangeTimelineClips(mixedTimeline([long, lateIn, sound], TRACKS, [SHORT_SOURCE, AUDIO]), EMPTY_RESOLUTION);
    expect(view[long.id]).toEqual({ ...long, durationFrames: 48 });
    expect(view[lateIn.id]).toEqual({ ...lateIn, durationFrames: 8 });
    expect(view[sound.id]).toEqual({ ...sound, durationFrames: 120 });
  });

  it('cuts by seconds when the source rate and the Timeline rate differ and the clip plays at another speed', () => {
    // 2 s at 50 fps under a 25 fps Timeline at double speed: frame j samples 2j/25 s, inside while j < 25.
    const SOURCE50: TimelineVideoSource = { ...SOURCE, timebase: { num: 50, den: 1 }, extentFrames: 100, durationSeconds: '2' };
    const fast = clip(cid(1), V2, 0, 100, { rate: { num: 2, den: 1 } });
    // From source frame 50 (1 s): j < 12.5, so 13 frames.
    const fastLate = clip(cid(2), V3, 0, 100, { rate: { num: 2, den: 1 }, sourceInFrame: 50 });
    const document: TimelineDocumentV1 = { ...mixedTimeline([fast, fastLate], TRACKS, [SOURCE50]), settings: { width: 1920, height: 1080, fps: { num: 25, den: 1 } } };
    const view = arrangeTimelineClips(document, EMPTY_RESOLUTION);
    expect(view[fast.id]?.durationFrames).toBe(25);
    expect(view[fastLate.id]?.durationFrames).toBe(13);
  });

  it('keeps a web copy\'s length while its range is unknown, and cuts it once the resolution knows its source', () => {
    const waiting = webClip(cid(1), V2, 0, 500, waitingFor(EXEC_GONE));
    const bound = webClip(cid(2), V3, 0, 500);
    const view = arrangeTimelineClips(mixedTimeline([waiting, bound], TRACKS), RESOLUTION);
    expect(view[waiting.id]?.durationFrames).toBe(500);
    // SRC_A lasts 48 frames.
    expect(RESOLUTION.sources[SRC_A]?.durationFrames).toBe(48);
    expect(view[bound.id]?.durationFrames).toBe(48);
  });

  it('never cuts a picture, a text or a picture placeholder, however long', () => {
    const long = [imageClip(cid(1), V2, 0, 1_000_000), textClip(cid(2), V3, 0, 1_000_000), mediaUpload(cid(3), MAIN, 0, 1_000_000, 'image')];
    const view = arrangeTimelineClips(mixedTimeline(long, TRACKS), EMPTY_RESOLUTION);
    for (const item of long) expect(view[item.id]).toEqual(item);
  });

  it('leaves the document it reads unchanged', () => {
    const document = mixedTimeline([clip(cid(1), MAIN, 0, 80, { sourceId: SHORT_SOURCE.id })], TRACKS, [SHORT_SOURCE]);
    const before = structuredClone(document);
    arrangeTimelineClips(document, EMPTY_RESOLUTION);
    expect(document).toEqual(before);
  });
});

describe('pickTimelineClipAt: one clip per track and frame (design §3.5)', () => {
  it('lets the clip that starts later cover the one that starts earlier where they overlap', () => {
    const early = clip(cid(2), V2, 0, 100);
    const late = clip(cid(1), V2, 40, 20);
    const clips = { [early.id]: early, [late.id]: late };
    expect(pickTimelineClipAt(clips, V2, 39)?.id).toBe(early.id);
    expect(pickTimelineClipAt(clips, V2, 40)?.id).toBe(late.id);
    expect(pickTimelineClipAt(clips, V2, 59)?.id).toBe(late.id);
    expect(pickTimelineClipAt(clips, V2, 60)?.id).toBe(early.id);
    expect(pickTimelineClipAt(clips, V2, 100)).toBeUndefined();
    expect(pickTimelineClipAt(clips, MAIN, 50)).toBeUndefined();
  });

  it('picks the same one of two clips starting together whatever order the records arrive in', () => {
    const a = clip(cid(1), V2, 10, 30);
    const b = audioClip(cid(2), V2, 10, 50) as unknown as TimelineClip;
    const forward = pickTimelineClipAt({ [a.id]: a, [b.id]: b }, V2, 20);
    const backward = pickTimelineClipAt({ [b.id]: b, [a.id]: a }, V2, 20);
    expect(forward).toBeDefined();
    expect(backward?.id).toBe(forward?.id);
  });

  it('gives one answer per track and frame, the latest-starting presentable clip by its played length, for any overlapping, over-long or track-less document (fast-check)', () => {
    const TRACK_CHOICES = [MAIN, V2, V3, 'gone'];
    const seed = fc.record({
      track: fc.integer({ min: 0, max: TRACK_CHOICES.length - 1 }),
      startFrame: fc.integer({ min: 0, max: 80 }),
      durationFrames: fc.integer({ min: 1, max: 80 }),
      sourceInFrame: fc.integer({ min: 0, max: 47 }),
      kind: fc.constantFrom('video', 'image', 'text', 'missing'),
    });
    fc.assert(fc.property(fc.array(seed, { maxLength: 8 }), fc.integer({ min: 0, max: 170 }), (seeds, frame) => {
      const clips = seeds.map((item, index) => {
        const trackId = TRACK_CHOICES[item.track] ?? MAIN;
        if (item.kind === 'image') return imageClip(cid(index + 1), trackId, item.startFrame, item.durationFrames);
        if (item.kind === 'text') return textClip(cid(index + 1), trackId, item.startFrame, item.durationFrames);
        return clip(cid(index + 1), trackId, item.startFrame, item.durationFrames, {
          sourceInFrame: item.sourceInFrame, sourceId: item.kind === 'missing' ? '10000000-0000-4000-8000-0000000000ff' : SHORT_SOURCE.id,
        });
      });
      const forward = arrangeTimelineClips(mixedTimeline(clips, TRACKS, [SHORT_SOURCE, IMAGE]), EMPTY_RESOLUTION);
      const backward = arrangeTimelineClips(mixedTimeline([...clips].reverse(), TRACKS, [SHORT_SOURCE, IMAGE]), EMPTY_RESOLUTION);
      // Reference model, independent of the code under test: the played length of a rate-1 clip of a 48-frame source.
      const played = (item: (typeof clips)[number]): number => (item.kind === 'video' ? Math.min(item.durationFrames, 48 - item.sourceInFrame) : item.durationFrames);
      const presentable = clips.filter((item) => item.trackId !== 'gone' && (item.kind !== 'video' || item.sourceId === SHORT_SOURCE.id));
      for (const trackId of TRACK_CHOICES) {
        const picked = pickTimelineClipAt(forward, trackId, frame);
        expect(pickTimelineClipAt(backward, trackId, frame)?.id).toBe(picked?.id);
        const covering = presentable.filter((item) => item.trackId === trackId && item.startFrame <= frame && frame < item.startFrame + played(item));
        if (covering.length === 0) {
          expect(picked, `${trackId}@${frame}`).toBeUndefined();
          continue;
        }
        const latest = Math.max(...covering.map((item) => item.startFrame));
        expect(covering.filter((item) => item.startFrame === latest).map((item) => item.id)).toContain(picked?.id);
      }
    }), { numRuns: 400 });
  });
});
