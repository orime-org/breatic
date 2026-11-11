// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { VIDEO_TOOL_IDS, videoToolDraftSchema, type VideoToolDialogueRow, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';
import { createVideoToolDraft, resetDialoguePeople, editDialogue, trimTimelineClip } from '../video/video-tool-edit';

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
  // §97 (frames-split §10.6 删除行): a new frame draft starts on Current with no interval period.
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
      // The dialog bounds the end at maxEnd = end + duration - out.
      const [, second] = trimTimelineClip(cut, cut[1]!.clipId, reported(3), reported(3 + 2.9 + 3.008 - 2.9), 3.008);
      expect(second!.out).toBeLessThanOrEqual(3.008);
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
