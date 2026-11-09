// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { TimelineDocumentV1, TimelineRate, TimelineTrack, TimelineVideoSource } from '@breatic/shared';

import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import { SOURCE } from '@web/data/yjs/__tests__/timeline-document-fixtures';

const tracks = [{ id: 'visual-1', kind: 'visual' as const, order: 0 }];
const baseClip = {
  id: '30000000-0000-4000-8000-000000000001',
  trackId: 'visual-1',
  kind: 'video' as const,
  sourceId: '10000000-0000-4000-8000-000000000001',
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 48,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

const FPS: TimelineRate = { num: 24, den: 1 };

/**
 * The whole document the arrangement reads (inner#1708 Q4); SOURCE spans 1000 frames, so ranges are inside it.
 * @param clips - The placements.
 * @param trackList - The tracks.
 * @param sources - The stored sources.
 * @param fps - The Timeline rate.
 * @returns The document.
 * @throws {never} Never.
 */
function documentOf(
  clips: ReadonlyArray<typeof baseClip>, trackList: readonly TimelineTrack[] = tracks,
  sources: Record<string, TimelineVideoSource> = { [SOURCE.id]: SOURCE }, fps: TimelineRate = FPS,
): TimelineDocumentV1 {
  return {
    schemaVersion: 1,
    settings: { width: 1920, height: 1080, fps },
    tracks: Object.fromEntries(trackList.map((item) => [item.id, item])),
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
    sources,
    operationReceipts: {},
  };
}

/**
 * Give each generated placement a stable, valid clip identity.
 * @returns A complete video clip for arrangement-only tests.
 * @throws {never} Never.
 */
function placement(index: number, startFrame: number, durationFrames: number): typeof baseClip {
  return {
    ...baseClip,
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    startFrame,
    durationFrames,
  };
}

describe('Timeline arrangement from the complete current document', () => {
  it('reads an empty arrangement without creating tracks or clips', () => {
    expect(resolveTimelineArrangement(documentOf([]))).toEqual({ placements: [], conflicts: [], readyClipIds: [], hasConflicts: false });
  });

  it('accepts adjacent half-open intervals on the same track', () => {
    const next = placement(1, 48, 12);
    expect(resolveTimelineArrangement(documentOf([baseClip, next]))).toEqual({
      placements: [
        { clipId: baseClip.id, status: 'ready', reasons: [] },
        { clipId: next.id, status: 'ready', reasons: [] },
      ],
      conflicts: [],
      readyClipIds: [baseClip.id, next.id],
      hasConflicts: false,
    });
  });

  it('marks both overlapping placements and preserves their original intervals', () => {
    const next = placement(1, 47, 12);
    const clips = [baseClip, next];
    const before = structuredClone(clips);
    const result = resolveTimelineArrangement(documentOf(clips));
    expect(result.readyClipIds).toEqual([]);
    expect(result.hasConflicts).toBe(true);
    expect(result.placements).toEqual([
      { clipId: baseClip.id, status: 'conflict', reasons: [{ code: 'overlap', relatedClipIds: [next.id], startFrame: 47, endFrame: 48 }] },
      { clipId: next.id, status: 'conflict', reasons: [{ code: 'overlap', relatedClipIds: [baseClip.id], startFrame: 47, endFrame: 48 }] },
    ]);
    expect(result.conflicts).toEqual(result.placements);
    expect(clips).toEqual(before);
  });

  it('keeps a valid placement on another visual track available', () => {
    const otherTrack = { id: 'visual-2', kind: 'visual' as const, order: 1 };
    const overlaid = { ...placement(1, 0, 48), trackId: otherTrack.id };
    const result = resolveTimelineArrangement(documentOf([baseClip, overlaid], [...tracks, otherTrack]));
    expect(result.readyClipIds).toEqual([baseClip.id, overlaid.id]);
    expect(result.conflicts).toEqual([]);
  });

  it('reports a missing track without discarding the placement', () => {
    const result = resolveTimelineArrangement(documentOf([baseClip], []));
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ clipId: baseClip.id, status: 'conflict', reasons: [{ code: 'missing_track' }] });
    expect(result.readyClipIds).toEqual([]);
    expect(result.hasConflicts).toBe(true);
  });

  it('reports an incompatible track for a video placement', () => {
    const result = resolveTimelineArrangement(documentOf([baseClip], [{ id: 'visual-1', kind: 'audio', order: 0 }]));
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ clipId: baseClip.id, status: 'conflict', reasons: [{ code: 'incompatible_track' }] });
    expect(result.readyClipIds).toEqual([]);
  });

  it.each([
    { startFrame: -1 },
    { startFrame: 0.5 },
    { startFrame: Number.MAX_SAFE_INTEGER, durationFrames: 1 },
    { durationFrames: 0 },
    { durationFrames: -1 },
    { durationFrames: Number.NaN },
  ])('diagnoses merged invalid bounds %j independently from strict DTO validation', (changes) => {
    const result = resolveTimelineArrangement(documentOf([{ ...baseClip, ...changes }]));
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ clipId: baseClip.id, status: 'conflict', reasons: [{ code: 'invalid_range' }] });
    expect(result.readyClipIds).toEqual([]);
  });

  it('recomputes after a conflict is explicitly moved or a placement is removed', () => {
    const conflicting = placement(1, 47, 12);
    expect(resolveTimelineArrangement(documentOf([baseClip, conflicting])).hasConflicts).toBe(true);
    const moved = resolveTimelineArrangement(documentOf([baseClip, { ...conflicting, startFrame: 48 }]));
    expect(moved.readyClipIds).toEqual([baseClip.id, conflicting.id]);
    expect(moved.conflicts).toEqual([]);
    expect(resolveTimelineArrangement(documentOf([baseClip])).placements).toEqual([{ clipId: baseClip.id, status: 'ready', reasons: [] }]);
  });

  it('reports a clip whose source is not stored as missing_source and keeps it out of the ready clips (inner#1708 M1)', () => {
    const next = placement(1, 48, 12);
    const result = resolveTimelineArrangement(documentOf([baseClip, next], tracks, {}));
    expect(result.placements).toEqual([
      { clipId: baseClip.id, status: 'conflict', reasons: [{ code: 'missing_source', relatedClipIds: [], startFrame: 0, endFrame: 48 }] },
      { clipId: next.id, status: 'conflict', reasons: [{ code: 'missing_source', relatedClipIds: [], startFrame: 48, endFrame: 60 }] },
    ]);
    expect(result.readyClipIds).toEqual([]);
    expect(result.hasConflicts).toBe(true);
  });

  it('keeps a clip whose source is stored ready next to one whose source is missing (inner#1708 M1)', () => {
    const elsewhere = { ...placement(1, 48, 12), sourceId: '10000000-0000-4000-8000-0000000000ff' };
    const result = resolveTimelineArrangement(documentOf([baseClip, elsewhere]));
    expect(result.readyClipIds).toEqual([baseClip.id]);
    expect(result.conflicts).toEqual([{ clipId: elsewhere.id, status: 'conflict', reasons: [{ code: 'missing_source', relatedClipIds: [], startFrame: 48, endFrame: 60 }] }]);
  });

  describe('source range', () => {
    const fps = { num: 24, den: 1 };
    const source = {
      id: baseClip.sourceId,
      kind: 'video' as const,
      assetId: '20000000-0000-4000-8000-000000000001',
      timebase: fps,
      extentFrames: 48,
      durationSeconds: '2',
      durationOrigin: 'registered' as const,
    };
    const sources = { [source.id]: source };

    it('keeps a clip inside its source ready', () => {
      expect(resolveTimelineArrangement(documentOf([baseClip], tracks, sources, fps)).readyClipIds).toEqual([baseClip.id]);
    });

    it.each([
      { sourceInFrame: 1 },
      { durationFrames: 49 },
      { sourceInFrame: 40, durationFrames: 9 },
    ])('diagnoses a clip outside its source %j as invalid_range', (changes) => {
      const outside = { ...baseClip, ...changes };
      const result = resolveTimelineArrangement(documentOf([outside], tracks, sources, fps));
      expect(result.placements).toEqual([{
        clipId: baseClip.id,
        status: 'conflict',
        reasons: [{ code: 'invalid_range', relatedClipIds: [], startFrame: outside.startFrame, endFrame: outside.startFrame + outside.durationFrames }],
      }]);
      expect(result.readyClipIds).toEqual([]);
      expect(result.hasConflicts).toBe(true);
    });

    it('leaves a valid neighbour of an out-of-source clip ready', () => {
      const outside = { ...baseClip, sourceInFrame: 1 };
      const neighbour = placement(1, 48, 12);
      const result = resolveTimelineArrangement(documentOf([outside, neighbour], tracks, sources, fps));
      expect(result.readyClipIds).toEqual([neighbour.id]);
      expect(result.conflicts.map((item) => item.clipId)).toEqual([baseClip.id]);
    });
  });

  it('has the same classifications and reason order for any arrival order', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ startFrame: fc.integer({ min: 0, max: 120 }), durationFrames: fc.integer({ min: 1, max: 48 }) }), { maxLength: 12 }),
      (ranges) => {
        const clips = ranges.map((range, index) => placement(index, range.startFrame, range.durationFrames));
        const before = structuredClone(clips);
        const forward = resolveTimelineArrangement(documentOf(clips));
        const reverse = resolveTimelineArrangement(documentOf([...clips].reverse()));
        expect(reverse).toEqual(forward);
        expect(clips).toEqual(before);
        const ready = clips.filter((candidate) => forward.readyClipIds.includes(candidate.id));
        for (let left = 0; left < ready.length; left += 1) {
          for (let right = left + 1; right < ready.length; right += 1) {
            const a = ready[left];
            const b = ready[right];
            if (a === undefined || b === undefined) throw new Error('Generated placement index is missing');
            expect(a.startFrame + a.durationFrames <= b.startFrame || b.startFrame + b.durationFrames <= a.startFrame).toBe(true);
          }
        }
      },
    ));
  });
});
