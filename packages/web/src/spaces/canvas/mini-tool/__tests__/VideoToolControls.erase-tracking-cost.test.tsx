// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 擦除行; demo 2026-10-23-1306-video-tools `main.tsx` `tracking-cost`,
 * `revision-messages.json`; keys `canvas.miniTool.videoUI.trackingEstimate` / `trackingActual`): before tracking runs, the tracking estimate stands beside
 * the "Track selection" button ("Est. {credits}"); once a tracking run finished, the same place shows what it actually
 * used ("Used {credits}"). The cost is beside the button, not part of its label. `analysisActualCreditText` is a prop
 * name this test chose; no design fixes where the actual cost comes from yet.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const draft: VideoToolDraftById['video.erase'] = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { range: { start: 0, end: 5 }, anchor: { frameIndex: 0, pts: 0 }, region: { box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, points: [] }, trackingPrompt: '' },
};
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
const base = { toolId: 'video.erase' as const, draft, analyses: [], frameTable, presentedTime: 0, disabled: false, pickingSlot: null, inputNames: new Map<string, string>(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), onChange: vi.fn() };

/**
 * The cost text beside the Track selection button, checked to sit outside the button in the same row.
 * @param text - The cost text expected.
 * @returns The element holding it.
 */
function costBesideTrack(text: string): HTMLElement {
  const track = screen.getByRole('button', { name: new RegExp(t('canvas.miniTool.videoUI.trackObject')) });
  const cost = screen.getByText(text);
  expect(track.contains(cost)).toBe(false);
  expect(cost.closest('button')).toBeNull();
  expect(track.parentElement?.contains(cost) === true || cost.parentElement?.contains(track) === true).toBe(true);
  return cost;
}

describe('erase tracking cost beside Track selection (§97; canvas design §4 擦除)', () => {
  it('shows the tracking estimate beside the button before tracking runs', () => {
    render(<VideoToolControls {...base} analysisCreditText='8' />);
    costBesideTrack(t('canvas.miniTool.videoUI.trackingEstimate', { credits: '8' }));
  });

  it('shows what the finished tracking actually used in the same place, instead of the estimate', () => {
    const proposed: object = { analysisActualCreditText: '6' };
    render(<VideoToolControls {...base} analysisCreditText='8' {...proposed} />);
    costBesideTrack(t('canvas.miniTool.videoUI.trackingActual', { credits: '6' }));
    expect(screen.queryByText(t('canvas.miniTool.videoUI.trackingEstimate', { credits: '8' }))).toBeNull();
  });
});
