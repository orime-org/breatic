// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { VIDEO_TOOL_IDS, videoToolDraftSchema } from '@breatic/shared/mini-tools';
import { createVideoToolDraft } from '../video/video-tool-edit';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };

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
    expect(createVideoToolDraft('video.extract-frames', source).params).toEqual({ mode: 'current', frameIndex: 0 });
  });
});
