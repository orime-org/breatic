// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * When a canvas video still is the video a Motion Space exported (#1490 design §9.2, §9.3): only a video node whose
 * content is the exported video's address offers "open source animation". A video regenerated, uploaded over or
 * replaced keeps the field, but no longer offers it.
 */

import { describe, expect, it } from 'vitest';

import { sourceAnimationOf } from '@web/spaces/canvas/source-animation';

const LINK = { spaceId: 's0000000-0000-4000-8000-000000000001', executionId: 'e0000000-0000-4000-8000-000000000001', videoUrl: 'https://cdn.example/v.mp4' };

describe('sourceAnimationOf', () => {
  it('answers the Space and execution of a video still showing the exported video', () => {
    expect(sourceAnimationOf({ type: 'video', data: { content: LINK.videoUrl, sourceAnimation: LINK } })).toEqual({ spaceId: LINK.spaceId, executionId: LINK.executionId });
  });

  it('answers null once the video shows something else', () => {
    expect(sourceAnimationOf({ type: 'video', data: { content: 'https://cdn.example/other.mp4', sourceAnimation: LINK } })).toBeNull();
  });

  it('answers null for a video with no source animation', () => {
    expect(sourceAnimationOf({ type: 'video', data: { content: LINK.videoUrl } })).toBeNull();
  });

  it('answers null for any other node, whatever it carries', () => {
    expect(sourceAnimationOf({ type: 'image', data: { content: LINK.videoUrl, sourceAnimation: LINK } })).toBeNull();
  });
});
