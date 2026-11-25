// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video focus crop, the waiting card (frames-split design §5.5 "受理", "结果反馈", "界面状态", §7.18; test plan §68.1).
 * The press adds a local placeholder keyed by the request's `run_id` (the card is derived from it), sends one planned
 * request under its own run-once intent, and the placeholder stays until this browser sees the crop end: an admission
 * refusal or a released press removes it right away; otherwise the canvas layer settles it from the panel node's task row
 * (R) and the result marker (M) by the §7.18 table.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@web/data/api/mini-tools';
import type * as ToastModule from '@web/lib/toast';
import { idempotencyRetryDeadline, t } from '@breatic/shared';
import type { MiniToolPlannedRequest, MiniToolPresentationRef, VideoToolSourceRef } from '@breatic/shared/mini-tools';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import type { CropRect } from '@web/lib/crop-math';
import {
  runVideoFocusCrop,
  videoFocusCropRowOf,
  videoFocusCropSettlement,
  type VideoFocusCropPress,
  type VideoFocusCropRead as SettlementRead,
  type VideoFocusCropRow as RowEntry,
  type VideoFocusCropSettlement as Settlement,
} from '@web/spaces/canvas/focus/run-focus-crop';
import { canvasSessions } from '@web/stores/canvas-session';
import { getRunning, resetRunOnceForTests, spaceTaskIntent, type RunOnceOutcome } from '@web/stores/task-actions-in-flight';

vi.mock('@web/data/api/mini-tools', async (original) => ({ ...(await original<typeof ApiModule>()), miniToolsApi: { ...(await original<typeof ApiModule>()).miniToolsApi, runPlanned: vi.fn() } }));
vi.mock('@web/lib/toast', async (original) => ({ ...(await original<typeof ToastModule>()), toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const PROJECT = '30000000-0000-4000-8000-000000000001';
const SPACE = '30000000-0000-4000-8000-000000000002';
const PANEL = '30000000-0000-4000-8000-000000000003';
const SOURCE: VideoToolSourceRef = {
  nodeId: '30000000-0000-4000-8000-000000000004',
  canonicalURL: 'https://assets.example.test/video/clip.mp4',
  mediaInfo: { width: 1920, height: 1080, duration: 4, mimeType: 'video/mp4' },
};
const PRESENTATION_REF: MiniToolPresentationRef = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };
const CROP: CropRect = { x: 480, y: 270, width: 960, height: 540 };
const STARTED = Date.parse('2026-11-19T10:00:00.000Z');
const BUDGET = 2 * 60 * 60 * 1000;

type Answer = ApiModule.MiniToolPlannedRunAnswer;


/**
 * Press confirm once.
 * @param over - Fields to change.
 * @returns The press outcome.
 */
function pressConfirm(over: Partial<VideoFocusCropPress> = {}): Promise<RunOnceOutcome<Answer>> {
  return runVideoFocusCrop({ projectId: PROJECT, spaceId: SPACE, panelNodeId: PANEL, source: SOURCE, sourceName: 'Clip 7',
    presentationRef: PRESENTATION_REF, frameIndex: 42, crop: CROP, ...over });
}

/**
 * Settle one read.
 * @param read - What was read.
 * @returns The settlement.
 */
function settle(read: SettlementRead): Settlement {
  return videoFocusCropSettlement(read);
}

/**
 * The placeholders this Space holds for the panel node.
 * @returns Them.
 */
function placeholders(): Array<{ id: string; nodeId: string; name: string }> {
  return canvasSessions.of(SPACE).getState().pendingFocusUploads.filter((entry) => entry.nodeId === PANEL);
}

/**
 * The bodies sent so far.
 * @returns Them, in order.
 */
function sent(): MiniToolPlannedRequest[] {
  return vi.mocked(miniToolsApi.runPlanned).mock.calls.map(([body]) => body);
}

/**
 * A row the server answered with.
 * @param status - Its status.
 * @returns The row.
 */
function row(status: 'running' | 'done' | 'failed' | 'expired'): RowEntry {
  return { status, startedAt: new Date(STARTED).toISOString(), budgetMs: BUDGET, errorMessage: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRunOnceForTests();
  canvasSessions.clear();
});
afterEach(() => { resetRunOnceForTests(); vi.useRealTimers(); });

describe('the press: placeholder keyed by run_id (design §5.5 "受理", "结果反馈")', () => {
  it('F00: confirm adds a placeholder keyed by the request run_id at once and keeps it after admission', async () => {
    let answer: ((value: Answer) => void) | undefined;
    vi.mocked(miniToolsApi.runPlanned).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const work = pressConfirm();
    await Promise.resolve();
    expect(sent()).toHaveLength(1);
    const runId = sent()[0].run_id;
    expect(placeholders()).toEqual([{ id: runId, nodeId: PANEL, name: 'Clip 7' }]);
    expect(getRunning(spaceTaskIntent('mini-tool', SPACE, runId, 'video.focus-crop'))).toBeDefined();
    answer!({ task_id: runId, status: 'pending' });
    expect(await work).toEqual({ kind: 'done', result: { task_id: runId, status: 'pending' } });
    // Admission is not the end: the card waits for the row and the marker.
    expect(placeholders()).toEqual([{ id: runId, nodeId: PANEL, name: 'Clip 7' }]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('F07: a second confirm while the first request still waits sends its own run_id, and each settles on its own', async () => {
    let first: ((value: Answer) => void) | undefined;
    vi.mocked(miniToolsApi.runPlanned)
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
      .mockRejectedValueOnce(new ApiException({ status: 409, message: 'source version changed' }));
    const one = pressConfirm();
    const two = pressConfirm();
    await Promise.resolve(); await Promise.resolve();
    expect(sent()).toHaveLength(2);
    const [a, b] = sent().map((body) => body.run_id);
    expect(a).not.toBe(b);
    expect(await two).toMatchObject({ kind: 'failed' });
    expect(placeholders().map((entry) => entry.id)).toEqual([a]);
    first!({ task_id: a, status: 'pending' });
    expect(await one).toMatchObject({ kind: 'done' });
    expect(placeholders().map((entry) => entry.id)).toEqual([a]);
  });

  it('F07: the placeholder is in the list the three cap checks count for as long as the crop has not ended', async () => {
    vi.mocked(miniToolsApi.runPlanned).mockImplementation(async (body) => ({ task_id: body.run_id, status: 'pending' }));
    await pressConfirm();
    await pressConfirm();
    await pressConfirm();
    expect(placeholders()).toHaveLength(3);
  });

  it('F09: a final admission refusal removes the placeholder and says why', async () => {
    vi.mocked(miniToolsApi.runPlanned).mockRejectedValueOnce(new ApiException({ status: 409, message: 'source version changed' }));
    expect(await pressConfirm()).toMatchObject({ kind: 'failed' });
    expect(placeholders()).toEqual([]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('F09: a refusal because the video was updated toasts the server\'s presentationChanged text (design §5.5 界面状态)', async () => {
    const message = 'The video was updated. Pick the frame and region again.';
    vi.mocked(miniToolsApi.runPlanned).mockRejectedValueOnce(new ApiException({ status: 400, message, fromServer: true }));
    expect(await pressConfirm()).toMatchObject({ kind: 'failed' });
    expect(placeholders()).toEqual([]);
    expect(vi.mocked(toast.error).mock.calls).toEqual([[message]]);
  });

  it('F08: a press released past the resend deadline removes the placeholder without a toast of its own', async () => {
    vi.useFakeTimers();
    const deadline = idempotencyRetryDeadline('mini-tool', Date.now());
    // Offline: the answer stays unknown and the server names a wait that ends past the resend deadline.
    vi.mocked(miniToolsApi.runPlanned).mockRejectedValue(new ApiException({ status: 503, message: 'offline', network: true, retryAfterSeconds: (deadline - Date.now()) / 1000 + 1 }));
    const work = pressConfirm();
    await vi.advanceTimersByTimeAsync(0);
    expect(placeholders()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(deadline - Date.now() + 1000);
    expect(await work).toEqual({ kind: 'released' });
    expect(placeholders()).toEqual([]);
    // Only run-once's own "result unknown" toast; the crop adds none.
    expect(vi.mocked(toast.error).mock.calls).toEqual([[t('common.runOnce.unknownResult')]]);
  });
});

describe('F14: the card derivation table (design §7.18)', () => {
  const before = STARTED + 60_000;
  const after = STARTED + BUDGET + 1;
  it.each<[string, SettlementRead, Settlement]>([
    ['not answered yet', { row: 'admitting', outcome: undefined, now: before }, { placeholder: 'keep', toast: null, recheckAt: null }],
    ['cleared after admission, marker added', { row: 'cleared', outcome: 'added', now: before }, { placeholder: 'remove', toast: null, recheckAt: null }],
    ['cleared after admission, marker refused', { row: 'cleared', outcome: 'refused', now: before }, { placeholder: 'remove', toast: 'referencePoolFull', recheckAt: null }],
    ['cleared after admission, no marker', { row: 'cleared', outcome: undefined, now: before }, { placeholder: 'remove', toast: null, recheckAt: null }],
    ['running', { row: row('running'), outcome: undefined, now: before }, { placeholder: 'keep', toast: null, recheckAt: null }],
    ['done, no marker, before the deadline', { row: row('done'), outcome: undefined, now: before }, { placeholder: 'keep', toast: null, recheckAt: STARTED + BUDGET }],
    ['done, no marker, past the deadline', { row: row('done'), outcome: undefined, now: after }, { placeholder: 'remove', toast: null, recheckAt: null }],
    ['done, added', { row: row('done'), outcome: 'added', now: before }, { placeholder: 'remove', toast: null, recheckAt: null }],
    ['done, refused', { row: row('done'), outcome: 'refused', now: before }, { placeholder: 'remove', toast: 'referencePoolFull', recheckAt: null }],
    ['failed', { row: row('failed'), outcome: undefined, now: before }, { placeholder: 'remove', toast: 'error', recheckAt: null }],
    ['expired', { row: row('expired'), outcome: undefined, now: before }, { placeholder: 'remove', toast: 'error', recheckAt: null }],
    // inner#1968 design 3.9: a crop waiting for a running slot that the user cancels ends its row failed as `cancelled`.
    ['cancelled by the user while it waited', { row: { ...row('failed'), errorMessage: 'cancelled' }, outcome: undefined, now: before }, { placeholder: 'remove', toast: null, recheckAt: null }],
  ])('F14: %s', (_name, read, expected) => {
    expect(settle(read)).toEqual(expected);
  });
});

describe('F08: the placeholder stays until this browser sees the end (design §7.18)', () => {
  it('F08: a crop that ended while the panel was closed settles on the first read the same way (the read carries no panel state)', () => {
    expect(settle({ row: row('done'), outcome: 'added', now: STARTED + 5_000 })).toEqual({ placeholder: 'remove', toast: null, recheckAt: null });
    expect(settle({ row: row('failed'), outcome: undefined, now: STARTED + 5_000 })).toMatchObject({ placeholder: 'remove', toast: 'error' });
  });

  it('F08: a marker reached without a counts change settles the card by the marker alone', () => {
    // The task list is not read: the row is whatever was last seen (running), the marker decides.
    expect(settle({ row: row('running'), outcome: 'added', now: STARTED + 5_000 })).toMatchObject({ placeholder: 'remove', toast: null });
    expect(settle({ row: row('running'), outcome: 'refused', now: STARTED + 5_000 })).toMatchObject({ placeholder: 'remove', toast: 'referencePoolFull' });
  });

  it('F08: done without a marker waits for exactly its deadline, then goes without a toast', () => {
    const waiting = settle({ row: row('done'), outcome: undefined, now: STARTED + 10 });
    expect(waiting).toEqual({ placeholder: 'keep', toast: null, recheckAt: STARTED + BUDGET });
    expect(settle({ row: row('done'), outcome: undefined, now: waiting.recheckAt! })).toEqual({ placeholder: 'remove', toast: null, recheckAt: null });
  });

  it('F08: a row cleared before the first read removes the card without a toast', () => {
    expect(settle({ row: 'cleared', outcome: undefined, now: STARTED + 10 })).toEqual({ placeholder: 'remove', toast: null, recheckAt: null });
  });
});

describe('F14: the row the canvas layer reads from the panel node\'s task list (design §7.18)', () => {
  /**
   * Read one entry.
   * @param entry - The run's task-list entry, or none.
   * @returns The row.
   */
  function rowOf(entry: RowEntry | undefined): SettlementRead['row'] {
    return videoFocusCropRowOf(entry);
  }

  it('F14: carries the row\'s failure reason, so a cancel is told apart from a failure', () => {
    const entry: RowEntry = { status: 'failed', startedAt: new Date(STARTED).toISOString(), budgetMs: BUDGET, errorMessage: 'cancelled' };
    expect(rowOf(entry)).toEqual(entry);
    expect(settle({ row: rowOf(entry), outcome: undefined, now: STARTED + 10 })).toEqual({ placeholder: 'remove', toast: null, recheckAt: null });
  });

  it('F14: an absent entry is a cleared row', () => {
    expect(rowOf(undefined)).toBe('cleared');
  });
});
