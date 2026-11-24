// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MiniToolAnalysisRecord } from '@breatic/shared/mini-tools';
import { t } from '@breatic/shared';
import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const common = { version: 1 as const, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [] };
// The selected version's grid: 7 frames at 25 fps, 0.28 s, while the registered duration says 5 s.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
const base = { analyses: [], grid, presentedTime: 0.13, disabled: false, onAnalyse: vi.fn(), analysing: false,
};

describe('approved production video parameter controls', () => {
  // frames-split §7: planVideoSplit refuses a cut at or past the grid's end (7 frames, 0.28 s here, not the stored 5 s).
  it('refuses a split cut at or past the presentation end, as the slider does', () => {
    const onChange = vi.fn();
    render(<VideoToolControls {...base} toolId='video.split' draft={{ ...common, params: { cuts: [2] } }} onChange={onChange} />);
    const input = screen.getByTestId('video-cut-0');
    for (const value of ['1', '0.28']) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    fireEvent.change(input, { target: { value: '0.2' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(onChange).toHaveBeenCalledOnce();
  });
  it('starts scene analysis from inside Split', () => {
    const onAnalyse = vi.fn();
    render(<VideoToolControls {...base} onAnalyse={onAnalyse} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('video-detect-scenes'));
    expect(onAnalyse).toHaveBeenCalledWith('scene_cuts');
  });
});

describe('split scene detection and cut list (approved demo split state)', () => {
  /** A scene detection of the draft that ran and failed; a run of any outcome means the next press detects again. */
  const sceneRun: MiniToolAnalysisRecord = {
    schemaVersion: 1, draftId: common.draftId, revision: common.revision, analysisRunId: '80000000-0000-4000-8000-000000000003', acceptedAt: '2026-10-24T00:00:00.000001Z',
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: source.canonicalURL, kind: 'video', mediaInfo: source.mediaInfo },
    analysisInput: { schemaVersion: 1, sourceURL: source.canonicalURL, kind: 'scene_cuts', range: { start: 0, end: 7 }, profile: { id: 'scenes', version: '1', weightsHash: null, params: {} } },
    inputFingerprint: 'b'.repeat(64), kind: 'scene_cuts', status: 'failed', artifactUnavailable: false, error: { code: 'failed' }, usage: [], result: null,
  };
  it('reads Detect scenes before any detection and Detect again after one', () => {
    const { unmount } = render(<VideoToolControls {...base} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-detect-scenes')).toHaveTextContent(t('canvas.miniTool.videoUI.detectScenes'));
    unmount();
    render(<VideoToolControls {...base} analyses={[sceneRun]} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-detect-scenes')).toHaveTextContent(t('canvas.miniTool.videoUI.detectAgain'));
  });
  // frames-split §7.19 分析: a detection the user cancelled has its own state and is no failure.
  it('shows the failed detection row for a failed detection and none for a cancelled one', () => {
    const { unmount } = render(<VideoToolControls {...base} analyses={[sceneRun]} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-detection-error')).toBeInTheDocument();
    unmount();
    const cancelled = { ...sceneRun, status: 'cancelled', error: null } as unknown as MiniToolAnalysisRecord;
    render(<VideoToolControls {...base} analyses={[cancelled]} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    expect(screen.queryByTestId('video-detection-error')).toBeNull();
    expect(screen.getByTestId('video-detect-scenes')).toHaveTextContent(t('canvas.miniTool.videoUI.detectAgain'));
  });
  it('says how to add cuts while the list is empty', () => {
    const { unmount } = render(<VideoToolControls {...base} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    expect(screen.getByText(t('canvas.miniTool.videoUI.noCuts'))).toBeInTheDocument();
    unmount();
    render(<VideoToolControls {...base} toolId='video.split' draft={{ ...common, params: { cuts: [2] } }} onChange={vi.fn()} />);
    expect(screen.queryByText(t('canvas.miniTool.videoUI.noCuts'))).toBeNull();
  });
});
