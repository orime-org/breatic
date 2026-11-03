// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { VIDEO_TOOL_IDS, videoToolDraftSchema, type VideoToolDialogueRow, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';
import { createVideoToolDraft, resetDialoguePeople, editDialogue, trimTimelineClip, moveTimelineClip } from '../video/video-tool-edit';

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
  it('reorders by composition centre and retains all clip identities and source trims', () => {
    expect(moveTimelineClip(clips, clips[1].clipId, 0, 1)).toEqual([clips[1], clips[0]]);
  });
  it('never changes another row during an independent timing edit', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (startTime) => {
      const result = editDialogue(rows, rows[1].dialogueId, { startTime });
      expect(result).toEqual([rows[0], { ...rows[1], startTime }, rows[2]]);
    }));
  });
});
