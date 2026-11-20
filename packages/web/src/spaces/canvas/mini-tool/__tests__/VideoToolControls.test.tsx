// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { t, type ModelEntry } from '@breatic/shared';
import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const common = { version: 1 as const, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [] };
const row = { dialogueId: '40000000-0000-4000-8000-000000000001', personId: null, analysisRunId: null, audioInputId: null, startTime: 0 };
// The selected version's grid: 7 frames at 25 fps, 0.28 s, while the registered duration says 5 s.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
const base = { analyses: [], grid, presentedTime: 0.13, disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(),
};

const lipSyncModel: ModelEntry & { minDurationSeconds: number; maxDurationSeconds: number } = { name: 'sync-lipsync-3', display_name: 'Sync Lipsync 3', modality: 'video', mode: 'talking_head', description: '', guide: '', tier: 'optional', generation_time: 600, takes_prompt: false, params: {}, availability: { upstreams: [] }, minDurationSeconds: 1, maxDurationSeconds: 300 };
const lipSync = { models: [lipSyncModel], tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 } };

describe('approved production video parameter controls', () => {
  it('keeps Free and seven expansion ratios in two rows of four', () => {
    const draft: VideoToolDraftById['video.expand'] = { ...common, params: { frame: { x: 0, y: 0, width: 1, height: 1 }, ratio: 'free', prompt: '' } };
    render(<VideoToolControls {...base} toolId='video.expand' draft={draft} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-expand-ratios')).toHaveClass('grid-cols-4');
    expect(screen.getByTestId('video-expand-ratios').querySelectorAll('button')).toHaveLength(8);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
  // Demo outpaint-controls.tsx: the ratio grid sits under its heading, the image Expand panel's own.
  it('heads the expansion ratios with the image Expand panel\'s heading', () => {
    const draft: VideoToolDraftById['video.expand'] = { ...common, params: { frame: { x: 0, y: 0, width: 1, height: 1 }, ratio: 'free', prompt: '' } };
    render(<VideoToolControls {...base} toolId='video.expand' draft={draft} onChange={vi.fn()} />);
    const heading = screen.getByText(t('canvas.miniTool.param.aspect.label'));
    expect(heading.nextElementSibling).toBe(screen.getByTestId('video-expand-ratios'));
  });
  // Canvas design §4 lip-sync row: the bottom row holds the model on the left and the duration mode on the right.
  it('offers all five complete duration policies from the mode pill on the bottom row', () => {
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} lipSync={lipSync} />);
    const mode = screen.getByTestId('video-sync-mode');
    expect(mode.textContent).toContain('Cut off');
    expect(screen.getByTestId('video-lipsync-bottom-row').contains(mode)).toBe(true);
    expect(screen.getByTestId('video-lipsync-bottom-row').contains(screen.getByTestId('generate-model-trigger'))).toBe(true);
    fireEvent.click(mode);
    expect(['cut_off', 'silence', 'loop', 'bounce', 'remap'].map((value) => screen.getByTestId(`video-sync-${value}`).textContent)).toEqual(['Cut off', 'Silence', 'Loop', 'Bounce', 'Remap']);
  });
  it('locks the model and the duration mode while the panel is disabled', () => {
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} lipSync={lipSync} disabled />);
    expect(screen.getByTestId('video-sync-mode')).toBeDisabled();
    expect(screen.getByTestId('generate-model-trigger')).toBeDisabled();
  });
  it('says start times follow the video and silence inside each audio is kept', () => {
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} />);
    expect(screen.getByText(t('canvas.miniTool.videoUI.dialogueTimingHint'))).toBeInTheDocument();
  });
  it('shows the audio, person and zero-second input on one compact dialogue row', () => {
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} />);
    const main = screen.getByTestId(`video-dialogue-${row.dialogueId}`);
    expect(main.contains(screen.getByTestId(`video-audio-${row.dialogueId}`))).toBe(true);
    expect(main.contains(screen.getByTestId(`video-start-${row.dialogueId}`))).toBe(true);
    expect(screen.getByTestId(`video-start-${row.dialogueId}`)).toHaveValue('0');
  });
  it('keeps invalid dialogue time visible and prevents committing it as a valid persisted number', () => {
    const onChange = vi.fn();
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={onChange} />);
    const input = screen.getByTestId(`video-start-${row.dialogueId}`);
    fireEvent.change(input, { target: { value: '-1' } });
    expect(input).toHaveValue('-1');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).toHaveBeenCalledTimes(0);
  });
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

/** Builds the complete accepted people contract used by the API and selector. */
function peopleRecord(runId: string, acceptedAt: string, failed = false): MiniToolAnalysisRecord {
  const identity = {
    schemaVersion: 1 as const, draftId: common.draftId, revision: common.revision, analysisRunId: runId, acceptedAt,
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: source.canonicalURL, kind: 'video' as const, mediaInfo: source.mediaInfo },
    analysisInput: { schemaVersion: 1 as const, sourceURL: source.canonicalURL, kind: 'people' as const, anchor: { frameIndex: 0 }, profile: { id: 'people', version: '1', weightsHash: null, params: {} } },
    inputFingerprint: 'b'.repeat(64),
  };
  return {
    ...identity, kind: 'people', status: failed ? 'failed' : 'completed', artifactUnavailable: false, error: failed ? { code: 'failed' } : null, usage: [],
    result: failed ? null : { ...identity, kind: 'people', anchor: { frameIndex: 0 }, people: [{ personId: 'person-a', faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] }] },
  };
}

describe('independent progress and reusable people results', () => {
  // Demo lip-sync-controls.tsx redetectPatch and failure branch (E6): a failed re-detect leaves no people to choose, so the
  // earlier identification's person is no longer shown on the row.
  it('stops showing the earlier person after a later identification fails', () => {
    const success = peopleRecord('80000000-0000-4000-8000-000000000001', '2026-10-24T00:00:00.000001Z');
    const failed = peopleRecord('80000000-0000-4000-8000-000000000002', '2026-10-24T00:00:00.000002Z', true);
    const dialogue = { ...row, personId: 'person-a', analysisRunId: success.analysisRunId };
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0 }, dialogues: [dialogue], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} analyses={[failed, success]} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} />);
    expect(screen.getByTestId(`video-person-${row.dialogueId}`)).not.toHaveTextContent('Person 1');
    expect(screen.getByTestId(`video-person-${row.dialogueId}`)).toBeDisabled();
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
  it('says how to add cuts while the list is empty', () => {
    const { unmount } = render(<VideoToolControls {...base} toolId='video.split' draft={{ ...common, params: { cuts: [] } }} onChange={vi.fn()} />);
    expect(screen.getByText(t('canvas.miniTool.videoUI.noCuts'))).toBeInTheDocument();
    unmount();
    render(<VideoToolControls {...base} toolId='video.split' draft={{ ...common, params: { cuts: [2] } }} onChange={vi.fn()} />);
    expect(screen.queryByText(t('canvas.miniTool.videoUI.noCuts'))).toBeNull();
  });
});
