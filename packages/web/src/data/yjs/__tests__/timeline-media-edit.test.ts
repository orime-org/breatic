// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Planning edits of mixed media (inner#1709 design §3).
 *
 * Tracks have no kind, so any clip goes on any track (§3.1). `add_media` replaces `add_video` for videos, pictures and
 * sounds; `add_text`, `set_text` and `set_audio` are new (§3.2). A sound is bounded by its file, a picture, a text and a
 * picture placeholder are unbounded at both ends and keep their in-point at 0 (§3.3). Linkage carries every clip that
 * can be shown (§3.3). The planner works on the view (§3.5): clips that cannot be shown take part in no layout and are
 * written back only where an overwrite, a track deletion or main-track packing reaches them; a clip longer than its
 * source is planned at the length it plays and written at that length only when the edit touches it. Every changed
 * record passes `TimelineClipSchema` or the edit is refused as `invalid_range` (§3.5).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';

import { arrangeTimelineClips } from '@web/data/yjs/timeline-arrangement';
import { TimelineEditCommandSchema, planTimelineEdit, type TimelineEditCommand, type TimelineEditPlacement, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import {
  LINK_ONLY, MAGNET_ONLY, MAIN, OFF, ON, SHORT_SOURCE, SOURCE, V2, V3, V4, cid, clip, idFactory, starts, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  AUDIO, IMAGE, MAX_GAIN, addMedia, addText, audioClip, imageClip, mediaUpload, mixedTimeline, setAudio, setText, textClip,
  type MediaClip, type MediaSource,
} from '@web/data/yjs/__tests__/timeline-media-fixtures';
import { EMPTY_RESOLUTION, addResult } from '@web/data/yjs/__tests__/timeline-web-fixtures';

type Accepted = Extract<TimelineEditPlan, { ok: true }>;

const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2), track(V4, 3)];
const MISSING = '10000000-0000-4000-8000-0000000000ff';

/**
 * A document of any clips on main and v2 to v4.
 * @param clips - The clips.
 * @param sources - The sources.
 * @returns The document.
 * @throws {never} Never.
 */
function doc(clips: readonly MediaClip[], sources: readonly MediaSource[] = [SOURCE, SHORT_SOURCE, IMAGE, AUDIO]): TimelineDocumentV1 {
  return mixedTimeline(clips, TRACKS, sources);
}

/**
 * Plan, checking the input is not changed.
 * @param current - The document.
 * @param command - The edit.
 * @param newId - The id factory.
 * @returns The plan.
 * @throws {Error} When planning mutates its input.
 */
function plan(current: TimelineDocumentV1, command: TimelineEditCommand, newId: () => string = idFactory()): TimelineEditPlan {
  const before = structuredClone(current);
  const result = planTimelineEdit(current, command, newId, EMPTY_RESOLUTION);
  expect(current).toEqual(before);
  return result;
}

/**
 * Narrow a plan to its accepted branch.
 * @param result - The plan.
 * @returns The accepted plan.
 * @throws {Error} When the plan was refused.
 */
function accepted(result: TimelineEditPlan): Accepted {
  if (!result.ok) throw new Error(`Expected an accepted plan, got ${result.reason}`);
  return result;
}

/**
 * The refusal reason of a plan, or "ok".
 * @param result - The plan.
 * @returns Its reason.
 * @throws {never} Never.
 */
function reasonOf(result: TimelineEditPlan): string {
  return result.ok ? 'ok' : result.reason;
}

/**
 * A clip of the planned document, as a loose record for checking kind-specific fields.
 * @param result - The accepted plan.
 * @param id - The clip id.
 * @returns The clip.
 * @throws {never} Never.
 */
function clipOf(result: Accepted, id: string): Record<string, unknown> | undefined {
  return result.next.clips[id] as unknown as Record<string, unknown> | undefined;
}

const move = (clipId: string, startFrame: number, placement: TimelineEditPlacement, target: { trackId?: string; newTrackId?: string } = {}): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame, ...target }, placement });
const setRange = (clipId: string, startFrame: number, sourceInFrame: number, durationFrames: number, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'set_range', parameters: { clipId, startFrame, sourceInFrame, durationFrames }, placement });
const split = (clipId: string, frame: number, newClipId: string, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'split', parameters: { clipId, frame, newClipId }, placement });
const duplicate = (clipId: string, newClipId: string, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'duplicate', parameters: { clipId, newClipId }, placement });
const remove = (clipId: string, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'delete', parameters: { clipId }, placement });
const deleteTrack = (trackId: string, placement: TimelineEditPlacement = ON): TimelineEditCommand =>
  ({ operation: 'delete_track', parameters: { trackId }, placement });

describe('the edit command schema (design §3.2)', () => {
  it('accepts add_media, add_text, set_text and set_audio, and no longer add_video', () => {
    for (const command of [
      addMedia(SOURCE, clip(cid(1), MAIN, 0, 10), ON),
      addMedia(IMAGE, imageClip(cid(1), V2, 0, 120), ON, 'fresh-track'),
      addMedia(AUDIO, audioClip(cid(1), V3, 0, 120), OFF),
      addText(cid(1), 0, 'fresh-track', 120, ON),
      setText(cid(1), { body: 'Hello', size: 0.1 }, OFF),
      setAudio(cid(1), 0.5, true, OFF),
      setAudio(cid(1), MAX_GAIN, false, OFF),
      setAudio(cid(1), 0, false, OFF),
    ]) expect(TimelineEditCommandSchema.safeParse(command).success, command.operation).toBe(true);
    const old = { operation: 'add_video', parameters: { source: SOURCE, clip: clip(cid(1), MAIN, 0, 10) }, placement: ON };
    expect(TimelineEditCommandSchema.safeParse(old).success).toBe(false);
  });

  it('rejects a gain below 0 or above +12 dB', () => {
    expect(TimelineEditCommandSchema.safeParse(setAudio(cid(1), -0.01, false, OFF)).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse(setAudio(cid(1), MAX_GAIN + 0.001, false, OFF)).success).toBe(false);
  });
});

describe('any clip on any track (design §3.1)', () => {
  it('places a picture, a sound and a text clip on the main track and on any other track, with the magnet on the main track', () => {
    const current = doc([clip(cid(1), MAIN, 0, 48)]);
    const sound = accepted(plan(current, addMedia(AUDIO, audioClip(cid(2), MAIN, 48, 60), ON)));
    expect(starts(sound.next, MAIN)).toEqual([[cid(1), 0, 48], [cid(2), 48, 60]]);
    const picture = accepted(plan(current, addMedia(IMAGE, imageClip(cid(3), MAIN, 30, 120), ON)));
    expect(starts(picture.next, MAIN)).toEqual([[cid(1), 0, 48], [cid(3), 48, 120]]);
    expect(accepted(plan(current, addMedia(IMAGE, imageClip(cid(4), V3, 10, 120), ON))).next.clips[cid(4)]).toMatchObject({ trackId: V3, startFrame: 10 });
  });

  it('moves a video onto a track that holds sounds and a sound onto the main track', () => {
    const current = doc([clip(cid(1), MAIN, 0, 48), audioClip(cid(2), V2, 0, 48), clip(cid(3), V3, 100, 20)]);
    expect(accepted(plan(current, move(cid(3), 60, OFF, { trackId: V2 }))).next.clips[cid(3)]).toMatchObject({ trackId: V2, startFrame: 60 });
    expect(starts(accepted(plan(current, move(cid(2), 48, MAGNET_ONLY, { trackId: MAIN }))).next, MAIN)).toEqual([[cid(1), 0, 48], [cid(2), 48, 48]]);
  });

  it('creates a new top track as { id, order }', () => {
    const result = accepted(plan(doc([]), addMedia(AUDIO, audioClip(cid(1), MAIN, 0, 60), ON, 'fresh-track')));
    expect(result.next.tracks['fresh-track']).toEqual({ id: 'fresh-track', order: 4 });
    expect(result.next.clips[cid(1)]?.trackId).toBe('fresh-track');
  });
});

describe('add_media (design §3.2)', () => {
  it('writes a picture source the document lacks and keeps the picture\'s given length', () => {
    const result = accepted(plan(mixedTimeline([], TRACKS, [SOURCE]), addMedia(IMAGE, imageClip(cid(1), V2, 0, 120), OFF)));
    expect(result.next.sources).toEqual({ [SOURCE.id]: SOURCE, [IMAGE.id]: IMAGE });
    expect(result.next.clips[cid(1)]).toEqual(imageClip(cid(1), V2, 0, 120));
    expect(result.created).toEqual([cid(1)]);
  });

  it('accepts a sound the document does not hold yet, at its full length, and refuses one longer than its file', () => {
    const current = mixedTimeline([], TRACKS, [SOURCE]);
    const result = accepted(plan(current, addMedia(AUDIO, audioClip(cid(1), V2, 0, 120), OFF)));
    expect(result.next.sources[AUDIO.id]).toEqual(AUDIO);
    expect(result.next.clips[cid(1)]?.durationFrames).toBe(120);
    expect(reasonOf(plan(current, addMedia(AUDIO, audioClip(cid(1), V2, 0, 121), OFF)))).toBe('invalid_range');
  });

  it('refuses a clip that names neither the given source nor a stored one', () => {
    expect(reasonOf(plan(doc([]), addMedia(IMAGE, imageClip(cid(1), V2, 0, 120, { sourceId: MISSING }), OFF)))).toBe('source_unavailable');
  });
});

describe('add_text (design §3.2)', () => {
  const TEXT = { body: 'Default text', size: 0.06 };

  it('writes a text clip with its words, size and length on the first free track above every drawn clip over its span', () => {
    const current = doc([clip(cid(1), MAIN, 0, 200), imageClip(cid(2), V2, 0, 200)]);
    const result = accepted(plan(current, addText(cid(9), 24, 'fresh-track', 120, ON, TEXT)));
    expect(result.next.clips[cid(9)]).toEqual(textClip(cid(9), V3, 24, 120, { text: TEXT }));
    expect(result.created).toEqual([cid(9)]);
    expect(Object.keys(result.next.tracks).sort()).toEqual(Object.keys(current.tracks).sort());
  });

  it('does not count a sound clip when finding the floor', () => {
    // V2 is empty over the span; the sound on V3 does not raise the floor, so the text goes on V2.
    const current = doc([clip(cid(1), MAIN, 0, 200), audioClip(cid(2), V3, 0, 120)]);
    expect(accepted(plan(current, addText(cid(9), 0, 'fresh-track', 120, ON))).next.clips[cid(9)]?.trackId).toBe(V2);
  });

  it('creates a new top track when no free track is above the drawn clips, moving and trimming nothing', () => {
    const current = doc([clip(cid(1), MAIN, 0, 200), imageClip(cid(2), V4, 0, 200), clip(cid(3), V2, 50, 10)]);
    const result = accepted(plan(current, addText(cid(9), 24, 'fresh-track', 120, ON)));
    expect(result.next.tracks['fresh-track']).toEqual({ id: 'fresh-track', order: 4 });
    expect(result.next.clips[cid(9)]?.trackId).toBe('fresh-track');
    for (const id of [cid(1), cid(2), cid(3)]) expect(result.next.clips[id]).toEqual(current.clips[id]);
  });

  it('refuses an id that is taken', () => {
    const current = doc([clip(cid(1), MAIN, 0, 200)]);
    expect(reasonOf(plan(current, addText(cid(1), 0, 'fresh-track', 120, ON)))).toBe('id_taken');
  });
});

describe('set_text (design §3.2)', () => {
  it('changes only the text of a text clip', () => {
    const current = doc([textClip(cid(1), V2, 10, 120), clip(cid(2), MAIN, 0, 48)]);
    const result = accepted(plan(current, setText(cid(1), { body: 'First line\nSecond line', size: 0.2 }, ON)));
    expect(result.next.clips[cid(1)]).toEqual(textClip(cid(1), V2, 10, 120, { text: { body: 'First line\nSecond line', size: 0.2 } }));
    expect(result.next.clips[cid(2)]).toEqual(current.clips[cid(2)]);
  });

  it('refuses a clip that is not text, and a missing clip, as target_missing', () => {
    const current = doc([imageClip(cid(1), V2, 0, 120)]);
    expect(reasonOf(plan(current, setText(cid(1), { body: 'x', size: 0.1 }, OFF)))).toBe('target_missing');
    expect(reasonOf(plan(current, setText(cid(9), { body: 'x', size: 0.1 }, OFF)))).toBe('target_missing');
  });
});

describe('set_audio (design §3.2)', () => {
  it('changes only the gain and mute of a video or a sound clip', () => {
    const current = doc([clip(cid(1), MAIN, 0, 48), audioClip(cid(2), V2, 0, 48)]);
    const video = accepted(plan(current, setAudio(cid(1), MAX_GAIN, true, ON)));
    expect(video.next.clips[cid(1)]).toEqual({ ...current.clips[cid(1)], gain: MAX_GAIN, mute: true });
    const sound = accepted(plan(current, setAudio(cid(2), 0.25, false, ON)));
    expect(sound.next.clips[cid(2)]).toEqual({ ...current.clips[cid(2)], gain: 0.25 });
    expect(sound.next.clips[cid(1)]).toEqual(current.clips[cid(1)]);
  });

  it('refuses a picture or a text clip', () => {
    const current = doc([imageClip(cid(1), V2, 0, 48), textClip(cid(2), V3, 0, 48)]);
    expect(plan(current, setAudio(cid(1), 0.5, false, OFF)).ok).toBe(false);
    expect(plan(current, setAudio(cid(2), 0.5, false, OFF)).ok).toBe(false);
  });
});

describe('ranges of pictures, texts and sounds (design §3.3)', () => {
  const STILLS: Array<[string, (id: string, trackId: string, start: number, length: number) => MediaClip]> = [
    ['a picture', imageClip],
    ['a text', textClip],
    ['a picture placeholder', (id, trackId, start, length) => mediaUpload(id, trackId, start, length, 'image')],
  ];

  it.each(STILLS)('stretches %s without limit at both ends, keeping its in-point at 0', (_name, build) => {
    const current = doc([build(cid(1), V2, 100, 120)]);
    expect(clipOf(accepted(plan(current, setRange(cid(1), 100, 0, 1_000_000, OFF))), cid(1))).toMatchObject({ startFrame: 100, sourceInFrame: 0, durationFrames: 1_000_000 });
    expect(clipOf(accepted(plan(current, setRange(cid(1), 0, 0, 220, OFF))), cid(1))).toMatchObject({ startFrame: 0, sourceInFrame: 0, durationFrames: 220 });
    expect(clipOf(accepted(plan(current, setRange(cid(1), 130, 0, 90, OFF))), cid(1))).toMatchObject({ startFrame: 130, sourceInFrame: 0, durationFrames: 90 });
  });

  it.each(STILLS)('refuses a set_range giving %s an in-point other than 0 as invalid_range', (_name, build) => {
    expect(plan(doc([build(cid(1), V2, 100, 120)]), setRange(cid(1), 130, 30, 90, OFF))).toEqual({ ok: false, reason: 'invalid_range' });
  });

  it.each(STILLS)('keeps the in-point of %s at 0 when split, and when another clip covers its head or middle', (_name, build) => {
    const current = doc([build(cid(1), V2, 0, 120), clip(cid(2), V3, 0, 10)]);
    const cut = accepted(plan(current, split(cid(1), 50, cid(3), OFF)));
    expect(clipOf(cut, cid(3))).toMatchObject({ startFrame: 50, sourceInFrame: 0, durationFrames: 70 });
    const head = accepted(plan(current, move(cid(2), 0, OFF, { trackId: V2 })));
    expect(clipOf(head, cid(1))).toMatchObject({ startFrame: 10, sourceInFrame: 0, durationFrames: 110 });
    const middle = accepted(plan(current, move(cid(2), 40, OFF, { trackId: V2 })));
    const right = middle.created[0] ?? '';
    expect(clipOf(middle, right)).toMatchObject({ startFrame: 50, sourceInFrame: 0, durationFrames: 70 });
  });

  it('bounds a sound by its file at both ends', () => {
    const current = doc([audioClip(cid(1), V2, 100, 60, { sourceInFrame: 30 })]);
    expect(reasonOf(plan(current, setRange(cid(1), 100, 30, 91, OFF)))).toBe('invalid_range');
    expect(reasonOf(plan(current, setRange(cid(1), 100, 30, 90, OFF)))).toBe('ok');
    expect(clipOf(accepted(plan(current, setRange(cid(1), 70, 0, 90, OFF))), cid(1))).toMatchObject({ startFrame: 70, sourceInFrame: 0 });
  });

  it('advances a sound placeholder\'s in-point by the frames its head loses', () => {
    // The placeholder's file lasts 60 frames (2.5 s).
    const current = doc([mediaUpload(cid(1), V2, 100, 60, 'audio'), clip(cid(2), V3, 0, 12)]);
    expect(clipOf(accepted(plan(current, setRange(cid(1), 112, 12, 48, OFF))), cid(1))).toMatchObject({ startFrame: 112, sourceInFrame: 12, durationFrames: 48 });
    expect(clipOf(accepted(plan(current, move(cid(2), 100, OFF, { trackId: V2 }))), cid(1))).toMatchObject({ startFrame: 112, sourceInFrame: 12, durationFrames: 48 });
  });
});

describe('linkage carries every clip that can be shown (design §3.3)', () => {
  it('moves a sound, a picture and a text attached to a main clip that moves', () => {
    const current = doc([
      clip(cid(1), MAIN, 0, 48), clip(cid(2), MAIN, 48, 48),
      audioClip(cid(3), V2, 60, 10), imageClip(cid(4), V3, 50, 10), textClip(cid(5), V4, 70, 10),
    ]);
    const result = accepted(plan(current, remove(cid(1), ON)));
    expect(result.next.clips[cid(3)]?.startFrame).toBe(12);
    expect(result.next.clips[cid(4)]?.startFrame).toBe(2);
    expect(result.next.clips[cid(5)]?.startFrame).toBe(22);
  });

  it('bumps a linked sound that would land on another clip to the first free track above', () => {
    const current = doc([
      clip(cid(1), MAIN, 0, 48), clip(cid(2), MAIN, 48, 48), imageClip(cid(3), V2, 10, 60), audioClip(cid(4), V2, 70, 10),
    ]);
    const result = accepted(plan(current, setRange(cid(1), 0, 0, 20, ON)));
    expect(result.next.clips[cid(4)]).toMatchObject({ trackId: V3, startFrame: 42 });
    expect(result.bumped).toEqual([cid(4)]);
  });

  it('carries neither a clip on a removed track nor a clip whose source record is missing, and bumps nothing for them', () => {
    const current = mixedTimeline([
      clip(cid(1), MAIN, 0, 48), clip(cid(2), MAIN, 48, 48), clip(cid(5), V2, 30, 10),
      clip(cid(3), 'gone', 60, 10), audioClip(cid(4), V2, 60, 10, { sourceId: MISSING }),
    ], TRACKS, [SOURCE, AUDIO]);
    const result = accepted(plan(current, remove(cid(1), ON)));
    expect(result.next.clips[cid(3)]).toEqual(current.clips[cid(3)]);
    expect(result.next.clips[cid(4)]).toEqual(current.clips[cid(4)]);
    expect(result.bumped).toEqual([]);
    expect(Object.keys(result.next.tracks).sort()).toEqual(Object.keys(current.tracks).sort());
  });
});

describe('clips that cannot be shown in the layout (design §3.5)', () => {
  it('deletes a track holding only clips that cannot be shown, and them with it', () => {
    const current = mixedTimeline([clip(cid(1), MAIN, 0, 48), clip(cid(2), V2, 0, 10, { sourceId: MISSING })], TRACKS, [SOURCE]);
    const result = accepted(plan(current, deleteTrack(V2)));
    expect(result.next.tracks[V2]).toBeUndefined();
    expect(result.next.clips[cid(2)]).toBeUndefined();
    expect(reasonOf(plan(doc([imageClip(cid(1), V2, 0, 10)]), deleteTrack(V2)))).toBe('track_not_empty');
  });

  it('does not count a clip that cannot be shown when finding a free track for a text or a web copy', () => {
    const current = mixedTimeline([clip(cid(1), MAIN, 0, 200), clip(cid(2), V2, 0, 200, { sourceId: MISSING })], TRACKS, [SOURCE]);
    expect(accepted(plan(current, addText(cid(9), 0, 'fresh-track', 120, ON))).next.clips[cid(9)]?.trackId).toBe(V2);
    expect(accepted(plan(current, addResult(cid(9), '80000000-0000-4000-8000-000000000001', 0, 'fresh-track', ON))).next.clips[cid(9)]?.trackId).toBe(V2);
  });

  it('puts a web copy above the drawn clips only, not above a sound (design §2.4)', () => {
    const current = doc([clip(cid(1), MAIN, 0, 200), audioClip(cid(2), V3, 0, 120)]);
    expect(accepted(plan(current, addResult(cid(9), '80000000-0000-4000-8000-000000000001', 0, 'fresh-track', ON))).next.clips[cid(9)]?.trackId).toBe(V2);
  });

  it('keeps the main-track order of the view when the dragged clip follows a clip that cannot be shown', () => {
    // Z cannot be shown and sits first on the main track; trimming A must leave A before C.
    const current = mixedTimeline([
      clip(cid(1), MAIN, 0, 10, { sourceId: MISSING }), clip(cid(2), MAIN, 10, 48), clip(cid(3), MAIN, 58, 48),
    ], TRACKS, [SOURCE]);
    const result = accepted(plan(current, setRange(cid(2), 10, 0, 30, ON)));
    expect(starts(result.next, MAIN)).toEqual([[cid(2), 0, 30], [cid(3), 30, 48]]);
  });
});

describe('a clip longer than its source is planned at the length it plays (design §3.5)', () => {
  /** X on V2 is 100 frames of the 48-frame source, so it plays 48; Y follows on V2 at 60. */
  const X = cid(1);
  const Y = cid(2);
  const overLong = doc([clip(X, V2, 0, 100, { sourceId: SHORT_SOURCE.id }), clip(Y, V2, 60, 20), clip(cid(3), MAIN, 0, 200)]);

  it('trims the clip after it on a sub track only where the moved clip\'s played frames reach it, writing the moved clip at that length', () => {
    const clear = accepted(plan(overLong, move(X, 10, OFF)));
    expect(clear.next.clips[Y]).toEqual(overLong.clips[Y]);
    expect(clear.next.clips[X]).toMatchObject({ startFrame: 10, durationFrames: 48 });
    const reaching = accepted(plan(overLong, move(X, 20, OFF)));
    expect(reaching.next.clips[Y]).toMatchObject({ startFrame: 68, sourceInFrame: 8, durationFrames: 12 });
  });

  it('moves its end one frame earlier when its right edge is dragged one frame left', () => {
    const result = accepted(plan(overLong, setRange(X, 0, 0, 47, OFF)));
    expect(result.next.clips[X]).toMatchObject({ startFrame: 0, durationFrames: 47 });
  });

  it('leaves it as stored when another clip is edited', () => {
    for (const command of [move(Y, 120, OFF), setRange(cid(3), 0, 0, 100, ON), remove(Y, OFF)]) {
      expect(accepted(plan(overLong, command)).next.clips[X], command.operation).toEqual(overLong.clips[X]);
    }
  });

  it('packs the magnetic main track end to end by the played lengths, after a split too', () => {
    const current = doc([clip(X, MAIN, 0, 100, { sourceId: SHORT_SOURCE.id }), clip(Y, MAIN, 100, 20)]);
    const result = accepted(plan(current, split(X, 24, cid(5), ON)));
    expect(starts(result.next, MAIN)).toEqual([[X, 0, 24], [cid(5), 24, 24], [Y, 48, 20]]);
    const moved = accepted(plan(current, move(Y, 0, ON)));
    expect(starts(moved.next, MAIN)).toEqual([[Y, 0, 20], [X, 20, 48]]);
  });
});

describe('editing the shown clips ignores the clips that cannot be shown (design §10 property)', () => {
  const TRACK_CHOICES = [MAIN, V2, V3];
  const visibleSeed = fc.record({
    track: fc.integer({ min: 0, max: TRACK_CHOICES.length - 1 }),
    startFrame: fc.integer({ min: 0, max: 200 }),
    durationFrames: fc.integer({ min: 1, max: 60 }),
    sourceInFrame: fc.oneof(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 960, max: 990 })),
    kind: fc.constantFrom('video', 'image', 'text', 'audio'),
  });
  const hiddenSeed = fc.record({
    track: fc.integer({ min: 0, max: TRACK_CHOICES.length }),
    startFrame: fc.integer({ min: 0, max: 200 }),
    durationFrames: fc.integer({ min: 1, max: 60 }),
  });
  const commandSeed = fc.record({
    operation: fc.integer({ min: 0, max: 7 }),
    pick: fc.nat(),
    frame: fc.integer({ min: 0, max: 260 }),
    length: fc.integer({ min: 1, max: 60 }),
    target: fc.integer({ min: 0, max: 2 }),
    magnet: fc.boolean(),
    linkage: fc.boolean(),
  });

  /**
   * One shown clip from its seed.
   * @param seed - The seed.
   * @param id - Its id.
   * @returns The clip.
   * @throws {never} Never.
   */
  function shown(seed: typeof visibleSeed extends fc.Arbitrary<infer T> ? T : never, id: string): MediaClip {
    const trackId = TRACK_CHOICES[seed.track] ?? MAIN;
    if (seed.kind === 'image') return imageClip(id, trackId, seed.startFrame, seed.durationFrames);
    if (seed.kind === 'text') return textClip(id, trackId, seed.startFrame, seed.durationFrames);
    if (seed.kind === 'audio') return audioClip(id, trackId, seed.startFrame, Math.min(seed.durationFrames, 120 - Math.min(seed.sourceInFrame, 60)), { sourceInFrame: Math.min(seed.sourceInFrame, 60) });
    return clip(id, trackId, seed.startFrame, seed.durationFrames, { sourceInFrame: seed.sourceInFrame });
  }

  it('gives the same result for the shown clips with or without clips on removed tracks or missing their source (fast-check)', () => {
    fc.assert(fc.property(fc.array(visibleSeed, { maxLength: 6 }), fc.array(hiddenSeed, { minLength: 1, maxLength: 4 }), commandSeed, (visibleSeeds, hiddenSeeds, seed) => {
      const visible = visibleSeeds.map((item, index) => shown(item, cid(index + 1)));
      const hidden = hiddenSeeds.map((item, index) => {
        const id = cid(index + 101);
        return item.track === TRACK_CHOICES.length
          ? clip(id, 'gone', item.startFrame, item.durationFrames)
          : clip(id, TRACK_CHOICES[item.track] ?? MAIN, item.startFrame, item.durationFrames, { sourceId: MISSING });
      });
      const hiddenIds = new Set(hidden.map((item) => item.id));
      const withHidden = doc([...visible, ...hidden], [SOURCE, IMAGE, AUDIO]);
      const without = doc(visible, [SOURCE, IMAGE, AUDIO]);
      const placement = { magnet: seed.magnet, linkage: seed.linkage };
      const subject = visible.length === 0 ? cid(99) : visible[seed.pick % visible.length]?.id ?? cid(99);
      const subjectClip = without.clips[subject];
      const target = [{}, { trackId: MAIN }, { trackId: V2 }][seed.target] ?? {};
      const commands: TimelineEditCommand[] = [
        move(subject, seed.frame, placement, target),
        setRange(subject, subjectClip?.startFrame ?? 0, subjectClip?.sourceInFrame ?? 0, seed.length, placement),
        split(subject, (subjectClip?.startFrame ?? 0) + (seed.frame % 30), cid(200), placement),
        duplicate(subject, cid(200), placement),
        remove(subject, placement),
        deleteTrack([V2, V3][seed.pick % 2] ?? V2, placement),
        addMedia(SOURCE, clip(cid(200), TRACK_CHOICES[seed.target] ?? MAIN, seed.frame, seed.length), placement),
        addText(cid(200), seed.frame, 'fresh-track', seed.length, placement),
      ];
      const command = commands[seed.operation] ?? commands[0];
      if (command === undefined) return;
      const a = planTimelineEdit(withHidden, command, idFactory('70000000'), EMPTY_RESOLUTION);
      const b = planTimelineEdit(without, command, idFactory('70000000'), EMPTY_RESOLUTION);
      expect(a.ok).toBe(b.ok);
      if (!a.ok || !b.ok) {
        expect(reasonOf(a)).toBe(reasonOf(b));
        return;
      }
      const shownOf = (document: TimelineDocumentV1): Record<string, TimelineClip> =>
        Object.fromEntries(Object.entries(arrangeTimelineClips(document, EMPTY_RESOLUTION)).filter(([id]) => !hiddenIds.has(id)));
      expect(shownOf(a.next)).toEqual(shownOf(b.next));
      expect(a.next.tracks).toEqual(b.next.tracks);
      expect(a.created).toEqual(b.created);
      expect(a.bumped).toEqual(b.bumped);
    }), { numRuns: 400 });
  });
});

describe('linkage and magnet switches reach mixed media the same way (design §3.3)', () => {
  it('leaves an attached sound in place when linkage is off', () => {
    const current = doc([clip(cid(1), MAIN, 0, 48), clip(cid(2), MAIN, 48, 48), audioClip(cid(3), V2, 60, 10)]);
    expect(accepted(plan(current, remove(cid(1), MAGNET_ONLY))).next.clips[cid(3)]?.startFrame).toBe(60);
    expect(accepted(plan(current, remove(cid(2), LINK_ONLY))).next.clips[cid(3)]).toBeUndefined();
  });
});
