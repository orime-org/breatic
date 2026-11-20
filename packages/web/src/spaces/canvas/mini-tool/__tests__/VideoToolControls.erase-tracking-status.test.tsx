// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 canvas design §4 erase row (changing the input asks to track again) and the approved demo's tracking-status line: the erase
 * panel says whether the tracking applies to the current selection, no longer applies, or has not been made.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';
import { eraseTrackingStatus } from '../video/video-tool-edit';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const draft: VideoToolDraftById['video.erase'] = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { range: { start: 0, end: 75 }, anchor: { frameIndex: 0 }, region: { box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, points: [] }, trackingPrompt: '' },
};
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

describe('the erase tracking status line', () => {
  it.each([
    ['tracked', 'trackingReview'],
    ['stale', 'trackingStale'],
    ['draw', 'drawBox'],
  ] as const)('reads %s as %s', (status, key) => {
    render(<VideoToolControls toolId='video.erase' draft={draft} analyses={[]} grid={grid} presentedTime={0} disabled={false} pickingSlot={null}
      inputNames={new Map()} onPick={vi.fn()} onAnalyse={vi.fn()} analysing={false} onEditTimeline={vi.fn()} onChange={vi.fn()} trackingStatus={status} />);
    expect(screen.getByTestId('video-tracking-status').textContent).toBe(t(`canvas.miniTool.videoUI.${key}`));
  });
});

describe('eraseTrackingStatus', () => {
  const done = { kind: 'tracked_mask' as const, status: 'completed' as const, artifactUnavailable: false };
  it('is tracked while a tracking matches the current selection', () => {
    expect(eraseTrackingStatus({ selected: true, matched: true, judged: true, records: [done] })).toBe('tracked');
  });
  it('is stale once the draft was tracked but no tracking matches the current selection', () => {
    expect(eraseTrackingStatus({ selected: true, matched: false, judged: true, records: [done] })).toBe('stale');
  });
  it('asks to draw while the draft was never tracked, or failed, or is still being judged', () => {
    expect(eraseTrackingStatus({ selected: true, matched: false, judged: true, records: [] })).toBe('draw');
    expect(eraseTrackingStatus({ selected: true, matched: false, judged: true, records: [{ ...done, status: 'failed' }] })).toBe('draw');
    expect(eraseTrackingStatus({ selected: true, matched: false, judged: false, records: [done] })).toBe('draw');
  });
  it('asks to draw once the selection is cleared, whatever was tracked before (demo SelectionOverlay reset)', () => {
    expect(eraseTrackingStatus({ selected: false, matched: false, judged: true, records: [done] })).toBe('draw');
  });
});
