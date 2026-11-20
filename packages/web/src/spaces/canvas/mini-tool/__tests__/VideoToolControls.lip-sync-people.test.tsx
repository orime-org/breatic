// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 lip-sync people section against the approved demo (lip-sync-controls.tsx, main.tsx person-failure block,
 * people-messages.json): the heading icon, the Re-detect / Retry identification label, the inline person cap, the per-row
 * start-time error, the playback strip's place, hiding people while identifying and after a failed identification, and
 * Add dialogue making the new row the active one.
 */

import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { LipsyncFailureReason, MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';

vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@web/spaces/canvas/mini-tool/FilmStrip', () => ({ FilmStrip: () => null }));

import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const ROW_A = '40000000-0000-4000-8000-000000000001'; const ROW_B = '40000000-0000-4000-8000-000000000002';
const RUN_OLD = '80000000-0000-4000-8000-000000000001'; const RUN_NEW = '80000000-0000-4000-8000-000000000002';
type Row = VideoToolDraftById['video.lip-sync']['params']['dialogues'][number];
const row = (dialogueId: string, personId: string | null = null, runId: string | null = null): Row => ({ dialogueId, personId, analysisRunId: runId, audioInputId: null, startTime: 0 });
const draftWith = (rows: Row[]): VideoToolDraftById['video.lip-sync'] => ({
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { anchor: { frameIndex: 0 }, dialogues: rows, syncMode: 'cut_off' },
});
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

/**
 * A people analysis record, as the panel reads it.
 * @param analysisRunId - The run.
 * @param status - Its status.
 * @param acceptedAt - When it was accepted, which orders records.
 * @param people - The person ids found, for a completed one.
 * @returns The record.
 */
function people(analysisRunId: string, status: 'completed' | 'failed' | 'running', acceptedAt: string, ids: readonly string[] = ['person-a', 'person-b']): MiniToolAnalysisRecord {
  return {
    analysisRunId, acceptedAt, kind: 'people', status, artifactUnavailable: false, error: null,
    result: status === 'completed' ? { kind: 'people', analysisRunId, anchor: { frameIndex: 0 }, people: ids.map((personId, index) => ({ personId, faceBox: { x: index * 0.4, y: 0, width: 0.2, height: 0.2 }, artifactRefs: [] })) } : null,
  } as unknown as MiniToolAnalysisRecord;
}

const ui = (key: string, params?: Record<string, string | number>): string => t(`canvas.miniTool.videoUI.${key}`, params);

/**
 * Mounts the lip-sync controls.
 * @param extra - Props overriding the defaults.
 * @returns The callbacks.
 */
function mount(extra: Record<string, unknown> = {}): { onChange: ReturnType<typeof vi.fn>; onActiveDialogue: ReturnType<typeof vi.fn>; onSeek: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn(); const onActiveDialogue = vi.fn(); const onSeek = vi.fn();
  const props: object = { toolId: 'video.lip-sync', draft: draftWith([row(ROW_A)]), analyses: [people(RUN_OLD, 'completed', '2026-11-01T00:00:00Z')], grid, presentedTime: 0, disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), onChange, onActiveDialogue, onSeek, lipSync: { models: [], tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 }, maxPeople: 1, maxDialogues: 8 }, ...extra };
  render(<VideoToolControls {...(props as React.ComponentProps<typeof VideoToolControls>)} />);
  return { onChange, onActiveDialogue, onSeek };
}

const controls = (): HTMLElement => screen.getByTestId('video-lip-sync-controls');

beforeEach(() => { vi.clearAllMocks(); });

describe('lip-sync people section (demo lip-sync-controls.tsx)', () => {
  it('E9 leads the People and dialogue heading with an icon', () => {
    mount();
    const heading = within(controls()).getByText(ui('dialoguePairs'));
    expect(heading.querySelector('svg')).not.toBeNull();
  });

  it('E2 reads Retry identification while the latest identification failed, Re-detect otherwise', () => {
    mount({ analyses: [people(RUN_OLD, 'completed', '2026-11-01T00:00:00Z'), people(RUN_NEW, 'failed', '2026-11-02T00:00:00Z')] });
    expect(screen.getByTestId('video-identify-people')).toHaveTextContent(ui('retryPeople'));
  });

  it('E2 reads Re-detect after a successful identification', () => {
    mount();
    expect(screen.getByTestId('video-identify-people')).toHaveTextContent(ui('redetectPeople'));
  });

  it('E3 suffixes a person over the cap with the person limit', () => {
    mount({ draft: draftWith([row(ROW_A, 'person-a', RUN_OLD), row(ROW_B)]) });
    fireEvent.click(screen.getByTestId(`video-person-${ROW_B}`));
    const over = screen.getByRole('option', { name: new RegExp(ui('personNumber', { number: 2 })) });
    expect(over).toHaveAttribute('aria-disabled', 'true');
    expect(over).toHaveTextContent(ui('personCapReached', { count: 1 }));
    expect(screen.getByRole('option', { name: ui('personNumber', { number: 1 }) })).not.toHaveTextContent(ui('personCapReached', { count: 1 }));
  });

  it.each(['', '-1'])('E4 says "%s" is not a valid start under its row', (text) => {
    mount();
    expect(screen.queryByText(ui('dialogueStartInvalid'))).toBeNull();
    fireEvent.change(screen.getByTestId(`video-start-${ROW_A}`), { target: { value: text } });
    const message = within(screen.getByTestId(`video-dialogue-${ROW_A}`)).getByText(ui('dialogueStartInvalid'));
    expect(message.className).toContain('col-span-4');
  });

  it('E5 puts the playback strip after the timing hint and before the model row, seeking the source', () => {
    const { onSeek } = mount();
    const strip = screen.getByTestId('video-playback-strip');
    const hint = screen.getByText(ui('dialogueTimingHint'));
    const bottom = screen.getByTestId('video-lipsync-bottom-row');
    expect(hint.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const track = screen.getByTestId('video-playback-track');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 10 } as DOMRect);
    fireEvent.pointerDown(track, { button: 0, clientX: 50 });
    expect(onSeek).toHaveBeenCalledWith(2.5);
  });

  it('E6 keeps the person dropdowns and Add dialogue unavailable after a failed re-detect', () => {
    mount({ analyses: [people(RUN_OLD, 'completed', '2026-11-01T00:00:00Z'), people(RUN_NEW, 'failed', '2026-11-02T00:00:00Z')] });
    expect(screen.getByTestId(`video-person-${ROW_A}`)).toBeDisabled();
    expect(screen.getByRole('button', { name: ui('addDialogue') })).toBeDisabled();
  });

  it('E6 keeps them unavailable while a re-detect is running', () => {
    mount({ analyses: [people(RUN_OLD, 'completed', '2026-11-01T00:00:00Z'), people(RUN_NEW, 'running', '2026-11-02T00:00:00Z')] });
    expect(screen.getByTestId(`video-person-${ROW_A}`)).toBeDisabled();
    expect(screen.getByRole('button', { name: ui('addDialogue') })).toBeDisabled();
  });

  it('E7 hides the person-failure block while identification restarts', () => {
    const reason: LipsyncFailureReason = { kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 1, step: 'faces', category: 'no_face' }], shared: null };
    mount({ lipSyncFailure: reason, analysing: true });
    expect(screen.queryByTestId('video-lip-sync-failure')).toBeNull();
  });

  it('E8 makes the added row the active one', () => {
    const { onChange, onActiveDialogue } = mount();
    fireEvent.click(screen.getByRole('button', { name: ui('addDialogue') }));
    const added = (onChange.mock.calls[0]![0] as VideoToolDraftById['video.lip-sync']).params.dialogues[1]!;
    expect(onActiveDialogue).toHaveBeenCalledExactlyOnceWith(added.dialogueId);
  });
});
