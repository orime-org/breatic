// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Dragging a web-animation copy's edge stops at its resolved source end (inner#1711 design §3.2: the source-length
 * cap in `previewTimelineGesture` reads `resolveTimelineClipExtent`, given through `options.web`).
 */

import { describe, expect, it } from 'vitest';

import { previewTimelineGesture } from '@web/spaces/timeline/timeline-gesture';
import { V2, cid, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { EXEC_RUNNING, RESOLUTION, SRC_A, boundTo, waitingFor, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

const OPTIONS = { snap: false, pixelsPerFrame: 1, playhead: 0, web: RESOLUTION };

describe('previewTimelineGesture on web copies', () => {
  it('stops a trimmed tail at the end of the source version', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 24, boundTo(SRC_A), { sourceInFrame: 12 })]);
    expect(previewTimelineGesture(doc, cid(1), 'trim-end', 100, null, OPTIONS)?.durationFrames).toBe(36);
  });

  it('stops a placeholder tail at its accepted length', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 24, waitingFor(EXEC_RUNNING))]);
    expect(previewTimelineGesture(doc, cid(1), 'trim-end', 100, null, OPTIONS)?.durationFrames).toBe(72);
  });

  it('opens a trimmed head back to the source start and no further', () => {
    const doc = timeline([webClip(cid(1), V2, 30, 24, boundTo(SRC_A), { sourceInFrame: 12 })]);
    expect(previewTimelineGesture(doc, cid(1), 'trim-start', -100, null, OPTIONS)).toMatchObject({ startFrame: 18, sourceInFrame: 0, durationFrames: 36 });
  });
});
