// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { VIDEO_TOOL_IDS, videoToolDraftSchema, type MiniToolAnalysisRecord, type VideoToolDialogueRow, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';
import { createVideoToolDraft, currentPeopleResult, overPeopleLimit, resetDialoguePeople, editDialogue, trimTimelineClip } from '../video/video-tool-edit';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const rows: VideoToolDialogueRow[] = [0, 1, 2].map((index) => ({ dialogueId: `20000000-0000-4000-8000-00000000000${index}`, personId: 'person-a', analysisRunId: '30000000-0000-4000-8000-000000000001', audioInputId: `40000000-0000-4000-8000-00000000000${index}`, startTime: [0, 1.25, 3][index] }));
const clips: VideoToolTimelineClip[] = [
  { clipId: '50000000-0000-4000-8000-000000000001', inputId: source.nodeId, in: 1, out: 4, transition: { kind: 'fade', duration: 0.5 } },
  { clipId: '50000000-0000-4000-8000-000000000002', inputId: '60000000-0000-4000-8000-000000000001', in: 2, out: 6, transition: { kind: 'cut', duration: 0 } },
];

describe('approved video tool edit boundaries', () => {
  it.each(VIDEO_TOOL_IDS)('initializes a valid independently identified %s draft', (toolId) => {
    const first = createVideoToolDraft(toolId, source);
    const second = createVideoToolDraft(toolId, source);
    expect(videoToolDraftSchema(toolId).parse(first)).toEqual(first);
    expect(first.source).toEqual(source);
    expect(first.draftId).not.toBe(second.draftId);
    expect(first.revision).not.toBe(second.revision);
  });
  // §97 (frames-split §10.6 removal row): a new frame draft starts on Current with no interval period.
  it('starts a frame draft on Current with no interval period', () => {
    expect(createVideoToolDraft('video.extract-frames', source).params).toEqual({ mode: 'current', currentTime: 0 });
  });

  it('retains every audio and explicit start when people are reidentified', () => {
    expect(resetDialoguePeople(rows)).toEqual(rows.map((row) => ({ ...row, personId: null, analysisRunId: null })));
    expect(rows.map((row) => row.personId)).toEqual(['person-a', 'person-a', 'person-a']);
  });
  it('edits only the selected dialogue despite repeated people', () => {
    expect(editDialogue(rows, rows[1].dialogueId, { startTime: 7 })).toEqual([rows[0], { ...rows[1], startTime: 7 }, rows[2]]);
  });
  it('retains the full source mapping when timeline handles trim a clip', () => {
    expect(trimTimelineClip(clips, clips[1].clipId, 3, 6)).toEqual([clips[0], { ...clips[1], in: 2.5, out: 5.5 }]);
  });
  describe('a track drag reported through the timeline library\'s pixel round trip (startLeft 32, 100 px per second)', () => {
    const reported = (seconds: number): number => (seconds * 100 + 32 - 32) / 100;
    const pair: VideoToolTimelineClip[] = [
      { clipId: '50000000-0000-4000-8000-000000000003', inputId: source.nodeId, in: 0, out: 3, transition: { kind: 'fade', duration: 0.08 } },
      { clipId: '50000000-0000-4000-8000-000000000004', inputId: '60000000-0000-4000-8000-000000000002', in: 0.28, out: 2.9, transition: { kind: 'cut', duration: 0 } },
    ];
    it('a start dragged to the source\'s first frame commits in point 0', () => {
      const [, second] = trimTimelineClip(pair, pair[1].clipId, reported(2.92 - 0.28), reported(2.92 + 2.62), 3.008);
      expect(second!.in).toBe(0);
    });
    it('an end dragged to the source\'s last frame commits no more than its duration', () => {
      const cut: VideoToolTimelineClip[] = [{ ...pair[0]!, transition: { kind: 'cut', duration: 0 } }, { ...pair[1]!, in: 0 }];
      // The dialog bounds the end at maxEnd = end + duration - out; a duration between whole milliseconds rounds up past itself.
      const [, second] = trimTimelineClip(cut, cut[1]!.clipId, reported(3), reported(3 + 2.9 + 3.0086 - 2.9), 3.0086);
      expect(second!.out).toBeLessThanOrEqual(3.0086);
    });
    it('commits in and out points in whole milliseconds', () => {
      fc.assert(fc.property(fc.integer({ min: 1, max: 280 }), fc.integer({ min: 0, max: 260 }), (inPx, outPx) => {
        const [, second] = trimTimelineClip(pair, pair[1].clipId, reported(2.92 - 0.28 + inPx / 100), reported(2.92 + 2.62 - outPx / 1000), 3.008);
        expect(Math.round(second!.in * 1000) / 1000).toBe(second!.in);
        expect(Math.round(second!.out * 1000) / 1000).toBe(second!.out);
      }));
    });
  });
  it('never changes another row during an independent timing edit', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (startTime) => {
      const result = editDialogue(rows, rows[1].dialogueId, { startTime });
      expect(result).toEqual([rows[0], { ...rows[1], startTime }, rows[2]]);
    }));
  });
});

// Demo lip-sync-controls.tsx redetectPatch and failure branch (E6): the people shown are those of the newest identification
// only; while a newer one runs or after it failed, there are none, even though an older one found people.
describe('currentPeopleResult', () => {
  const record = (analysisRunId: string, status: 'completed' | 'failed' | 'running', acceptedAt: string, artifactUnavailable = false): MiniToolAnalysisRecord => ({
    analysisRunId, acceptedAt, kind: 'people', status, artifactUnavailable, error: null,
    result: status === 'completed' ? { kind: 'people', analysisRunId, anchor: { frameIndex: 0, pts: 0 }, people: [] } : null,
  }) as unknown as MiniToolAnalysisRecord;
  const done = record('run-a', 'completed', '2026-11-01T00:00:00Z');

  it('returns the newest completed identification', () => {
    expect(currentPeopleResult([done])?.analysisRunId).toBe('run-a');
  });
  it.each(['failed', 'running'] as const)('returns none while the newest identification is %s', (status) => {
    expect(currentPeopleResult([done, record('run-b', status, '2026-11-02T00:00:00Z')])).toBeUndefined();
  });
  it('returns none when the newest identification lost its artifacts', () => {
    expect(currentPeopleResult([done, record('run-b', 'completed', '2026-11-02T00:00:00Z', true)])).toBeUndefined();
  });
  it('ignores records of other kinds', () => {
    expect(currentPeopleResult([done, { ...record('run-c', 'failed', '2026-11-03T00:00:00Z'), kind: 'scene_cuts' } as MiniToolAnalysisRecord])?.analysisRunId).toBe('run-a');
  });
});

// Canvas design line 98: binding a person is refused when the run would then take more distinct people than the limit.
describe('overPeopleLimit', () => {
  const row = (dialogueId: string, personId: string | null): VideoToolDialogueRow => ({ dialogueId, personId, analysisRunId: null, audioInputId: null, startTime: 0 });
  const bound = [row('row-a', 'person-a'), row('row-b', 'person-b'), row('row-c', null)];

  it('refuses a new person past the limit', () => {
    expect(overPeopleLimit(bound, 'row-c', 'person-c', 2)).toBe(true);
  });
  it('allows a person another row already takes', () => {
    expect(overPeopleLimit(bound, 'row-c', 'person-a', 2)).toBe(false);
  });
  it('does not count the edited row\'s own person', () => {
    expect(overPeopleLimit(bound, 'row-b', 'person-c', 2)).toBe(false);
  });
  it('allows anything while the limit is unknown', () => {
    expect(overPeopleLimit(bound, 'row-c', 'person-c', undefined)).toBe(false);
  });
});
