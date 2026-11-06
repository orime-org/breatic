// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 (canvas design §4 对口型行; demo 2026-10-23-1306-video-tools `lip-sync-controls.tsx`, `main.tsx`
 * `PersonFailureLines`, `people-messages.json`):
 * - the bottom row offers a `ModelPicker` listing the configured lip-sync models (config `executions.video.lip-sync.models`),
 *   the first, `sync-lipsync-3`, chosen by default, and a pick is stored as the draft's `params.modelId` (frames-split §8 item 3);
 * - a failed run is listed per person as "Person N" (N is the detection number) with its category and next step, plus one
 *   line for a failed shared step; "Retry failed items" is offered only when shared `lipsyncFailureRetryable(reason)` is true;
 *   beside a No face detected or Model rejected person, the other people follow that person's next step.
 * The props `lipSync`, `lipSyncFailure` and `onRetryFailed` are proposed shapes this test chose; no design fixes them yet.
 */

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelEntry } from '@breatic/shared';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';

vi.mock('@breatic/shared/mini-tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lipsyncFailureRetryable: vi.fn(),
}));

import * as miniTools from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';

type Category = 'no_face' | 'model_rejected' | 'timeout' | 'failed' | 'stopped';
type SharedStep = 'prepare' | 'composite' | 'stitch' | 'expired';
interface FailureReason { kind: 'lipsync'; persons: { personId: string; detectionNumber: number; step: 'track' | 'faces' | 'clip' | 'stem' | 'gen'; category: Category }[]; shared: { step: SharedStep; category: Category } | null }
const retryable = vi.mocked((miniTools as unknown as { lipsyncFailureRetryable: (reason: FailureReason) => boolean }).lipsyncFailureRetryable);

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const draft: VideoToolDraftById['video.lip-sync'] = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [{ dialogueId: '40000000-0000-4000-8000-000000000001', personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }], syncMode: 'cut_off' },
};
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
const base = { toolId: 'video.lip-sync' as const, draft, analyses: [], frameTable, presentedTime: 0, disabled: false, pickingSlot: null, inputNames: new Map<string, string>(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn() };

/**
 * A lip-sync model as the catalog lists it, with the duration range the config gives it.
 * @param name - The catalog name.
 * @param displayName - The name shown.
 * @returns The model.
 */
function model(name: string, displayName: string): ModelEntry & { min_duration_seconds: number; max_duration_seconds: number } {
  return { name, display_name: displayName, modality: 'video', mode: 'talking_head', description: '', guide: '', tier: 'optional', generation_time: 600, takes_prompt: false, params: {}, providers: [], min_duration_seconds: 1, max_duration_seconds: 300 };
}
const lipSync = { models: [model('sync-lipsync-3', 'Sync Lipsync 3'), model('ltx-2.3-lipsync', 'LTX 2.3 Lipsync')], tracking: { min_duration_seconds: 0.5, max_duration_seconds: 600 } };

/**
 * Mounts the lip-sync controls with the proposed extra props.
 * @param extra - The proposed props under test.
 * @param onChange - Receives every committed edit.
 * @returns Nothing.
 */
function mount(extra: Record<string, unknown>, onChange: (next: VideoToolDraftById['video.lip-sync']) => void = vi.fn()): void {
  const proposed: object = { lipSync, ...extra };
  render(<VideoToolControls {...base} onChange={onChange as (next: unknown) => void} {...proposed} />);
}

/**
 * A person line of a failure reason.
 * @param detectionNumber - The person's detection number.
 * @param category - Its failure category.
 * @param step - The step it ended on.
 * @returns The line.
 */
function person(detectionNumber: number, category: Category, step: FailureReason['persons'][number]['step'] = 'gen'): FailureReason['persons'][number] {
  return { personId: `person-${detectionNumber}`, detectionNumber, step, category };
}

/**
 * The lip-sync panel's whole text, failure lines included.
 * @returns The text.
 */
function panelText(): string {
  return screen.getByTestId('video-lip-sync-controls').textContent ?? '';
}

beforeEach(() => { vi.clearAllMocks(); });

describe('lip-sync model picker (§97; canvas design §4 对口型)', () => {
  it('lists the configured models in order with the first chosen by default', () => {
    mount({});
    const controls = screen.getByTestId('video-lip-sync-controls');
    const trigger = controls.querySelector('[data-testid="generate-model-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveTextContent('Sync Lipsync 3');
    fireEvent.click(trigger!);
    expect(screen.getAllByTestId(/^generate-model-option-/).map((option) => option.getAttribute('data-testid'))).toEqual(['generate-model-option-sync-lipsync-3', 'generate-model-option-ltx-2.3-lipsync']);
  });

  it('stores a picked model in the draft by its catalog name', () => {
    const onChange = vi.fn();
    mount({}, onChange);
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    fireEvent.click(screen.getByTestId('generate-model-option-ltx-2.3-lipsync'));
    expect(onChange).toHaveBeenCalledOnce();
    expect((onChange.mock.calls[0][0] as { params: Record<string, unknown> }).params).toMatchObject({ modelId: 'ltx-2.3-lipsync' });
  });
});

describe('lip-sync failure lines (§97; canvas design §4 对口型, execution design §9.4)', () => {
  it('names each failed person by detection number with its category and the retry step', () => {
    retryable.mockReturnValue(true);
    mount({ lipSyncFailure: { kind: 'lipsync', persons: [person(3, 'timeout', 'track'), person(5, 'failed', 'clip')], shared: null } satisfies FailureReason, onRetryFailed: vi.fn() });
    expect(panelText()).toMatch(/Person 3\W+Timed out\W*Retry the failed items\./);
    expect(panelText()).toMatch(/Person 5\W+Failed\W*Retry the failed items\./);
  });

  it.each([
    ['prepare', 'failed', 'Preparation failed'],
    ['composite', 'failed', 'Compositing failed'],
    ['stitch', 'failed', 'Stitching failed'],
    ['expired', 'timeout', 'Timed out'],
  ] as const)('shows one shared line for a failed %s step', (step, category, line) => {
    retryable.mockReturnValue(true);
    mount({ lipSyncFailure: { kind: 'lipsync', persons: [], shared: { step, category } } satisfies FailureReason, onRetryFailed: vi.fn() });
    expect(panelText()).toContain(line);
  });

  it('offers Retry failed items when the shared rule says the reason is retryable, and runs it', () => {
    retryable.mockReturnValue(true);
    const onRetryFailed = vi.fn();
    const reason: FailureReason = { kind: 'lipsync', persons: [person(1, 'timeout')], shared: null };
    mount({ lipSyncFailure: reason, onRetryFailed });
    expect(retryable).toHaveBeenCalledWith(reason);
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed items' }));
    expect(onRetryFailed).toHaveBeenCalledOnce();
  });

  it('offers no retry when the shared rule says the reason is not retryable', () => {
    retryable.mockReturnValue(false);
    const reason: FailureReason = { kind: 'lipsync', persons: [person(1, 'timeout')], shared: null };
    mount({ lipSyncFailure: reason, onRetryFailed: vi.fn() });
    expect(panelText()).toContain('Person 1');
    expect(retryable).toHaveBeenCalledWith(reason);
    expect(screen.queryByRole('button', { name: 'Retry failed items' })).toBeNull();
  });

  it('gives a rejected person the switch-model step', () => {
    retryable.mockReturnValue(false);
    mount({ lipSyncFailure: { kind: 'lipsync', persons: [person(2, 'model_rejected')], shared: null } satisfies FailureReason, onRetryFailed: vi.fn() });
    expect(panelText()).toMatch(/Person 2\W+Model rejected\W*Switch to another model and run again\./);
  });

  it('makes the timed-out, failed and stopped people follow the person with no face', () => {
    retryable.mockReturnValue(false);
    mount({ lipSyncFailure: { kind: 'lipsync', persons: [person(3, 'no_face', 'faces'), person(5, 'timeout'), person(6, 'failed'), person(7, 'stopped')], shared: null } satisfies FailureReason, onRetryFailed: vi.fn() });
    const text = panelText();
    expect(text).toMatch(/Person 3\W+No face detected\W*Delete this person's dialogue rows, or re-detect on another frame\./);
    expect(text).toMatch(/Person 5\W+Timed out\W*Follow Person 3's next step\./);
    expect(text).toMatch(/Person 6\W+Failed\W*Follow Person 3's next step\./);
    expect(text).toMatch(/Person 7\W+Stopped\W*(Stopped because of Person 3\. )?Follow Person 3's next step\./);
    expect(text).not.toContain('Retry the failed items.');
  });
});
