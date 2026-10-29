// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const common = { version: 1 as const, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [] };
const row = { dialogueId: '40000000-0000-4000-8000-000000000001', personId: null, analysisRunId: null, audioInputId: null, startTime: 0 };
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 1, step: 4, duration: 4 }, { start: 4, count: 3, step: 8, duration: 8 }] };
const base = { analyses: [], frameTable, presentedTime: 0.13, disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(),
};

describe('approved production video parameter controls', () => {
  it('keeps Free and seven expansion ratios in two rows of four', () => {
    const draft: VideoToolDraftById['video.expand'] = { ...common, params: { frame: { x: 0, y: 0, width: 1, height: 1 }, ratio: 'free', prompt: '' } };
    render(<VideoToolControls {...base} toolId='video.expand' draft={draft} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-expand-ratios')).toHaveClass('grid-cols-4');
    expect(screen.getByTestId('video-expand-ratios').querySelectorAll('button')).toHaveLength(8);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
  it('renders all five complete duration policies', () => {
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} />);
    expect(['cut_off', 'silence', 'loop', 'bounce', 'remap'].map((mode) => screen.getByTestId(`video-sync-${mode}`).textContent)).toEqual(['Cut off', 'Silence', 'Loop', 'Bounce', 'Remap']);
  });
  it('shows the audio, person and zero-second input on one compact dialogue row', () => {
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} />);
    const main = screen.getByTestId(`video-dialogue-${row.dialogueId}`);
    expect(main.contains(screen.getByTestId(`video-audio-${row.dialogueId}`))).toBe(true);
    expect(main.contains(screen.getByTestId(`video-start-${row.dialogueId}`))).toBe(true);
    expect(screen.getByTestId(`video-start-${row.dialogueId}`)).toHaveValue('0');
  });
  it('keeps invalid dialogue time visible and prevents committing it as a valid persisted number', () => {
    const onChange = vi.fn();
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [row], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} toolId='video.lip-sync' draft={draft} onChange={onChange} />);
    const input = screen.getByTestId(`video-start-${row.dialogueId}`);
    fireEvent.change(input, { target: { value: '-1' } });
    expect(input).toHaveValue('-1');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).toHaveBeenCalledTimes(0);
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
    analysisInput: { schemaVersion: 1 as const, sourceURL: source.canonicalURL, kind: 'people' as const, anchor: { frameIndex: 0, pts: 0 }, profile: { id: 'people', version: '1', weightsHash: null, params: {} } },
    inputFingerprint: 'b'.repeat(64),
  };
  return {
    ...identity, kind: 'people', status: failed ? 'failed' : 'completed', artifactUnavailable: false, error: failed ? { code: 'failed' } : null, usage: [],
    result: failed ? null : { ...identity, kind: 'people', anchor: { frameIndex: 0, pts: 0 }, people: [{ personId: 'person-a', faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] }] },
  };
}

describe('independent progress and reusable people results', () => {
  it('keeps the valid person visible after a later identification fails', () => {
    const success = peopleRecord('80000000-0000-4000-8000-000000000001', '2026-10-24T00:00:00.000001Z');
    const failed = peopleRecord('80000000-0000-4000-8000-000000000002', '2026-10-24T00:00:00.000002Z', true);
    const dialogue = { ...row, personId: 'person-a', analysisRunId: success.analysisRunId };
    const draft: VideoToolDraftById['video.lip-sync'] = { ...common, params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [dialogue], syncMode: 'cut_off' } };
    render(<VideoToolControls {...base} analyses={[failed, success]} toolId='video.lip-sync' draft={draft} onChange={vi.fn()} />);
    expect(screen.getByTestId(`video-person-${row.dialogueId}`)).toHaveTextContent('Person 1');
  });
});
