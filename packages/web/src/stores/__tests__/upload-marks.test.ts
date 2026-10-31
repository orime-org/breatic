// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The uploader's own marks on the nodes it is filling (inner#1303 §6.7): an
 * operation is waiting from the moment its node exists until the server
 * answers, or failed when it ends before that. Only the latest operation on a
 * node counts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUploadMarksStore } from '@web/stores/upload-marks';

const S = 'space-1';

/** The store's actions. */
const marks = () => useUploadMarksStore.getState();

/** The clock every start in these cases reads. */
const NOW = 1_700_000_000_000;

beforeEach(() => {
  useUploadMarksStore.setState({ marks: {} });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('upload marks', () => {
  it('records what the operation is and when it started', () => {
    marks().begin(S, 'n1', 'image.grid');
    expect(marks().markOf(S, 'n1')).toMatchObject({ state: 'waiting', action: 'image.grid', at: NOW });
  });

  it('waits from the start and clears on the answer', () => {
    const op = marks().begin(S, 'n1', 'upload');
    expect(marks().markOf(S, 'n1')).toEqual({ op, state: 'waiting', action: 'upload', at: NOW });
    marks().answer(S, 'n1', op);
    expect(marks().markOf(S, 'n1')).toBeUndefined();
  });

  it('keeps a failure with its message until the next start', () => {
    const op = marks().begin(S, 'n1', 'upload');
    marks().fail(S, 'n1', op, { key: 'canvas.upload.failed' });
    expect(marks().markOf(S, 'n1')).toEqual({ op, state: 'failed', action: 'upload', at: NOW, message: { key: 'canvas.upload.failed' } });
    const next = marks().begin(S, 'n1', 'upload');
    expect(marks().markOf(S, 'n1')).toEqual({ op: next, state: 'waiting', action: 'upload', at: NOW });
  });

  it('drops an answer or a failure from an operation a later start replaced', () => {
    const first = marks().begin(S, 'n1', 'upload');
    const second = marks().begin(S, 'n1', 'upload');
    marks().answer(S, 'n1', first);
    marks().fail(S, 'n1', first, { key: 'canvas.upload.failed' });
    expect(marks().markOf(S, 'n1')).toEqual({ op: second, state: 'waiting', action: 'upload', at: NOW });
  });

  it('drops an answer that reaches a failed mark', () => {
    const op = marks().begin(S, 'n1', 'upload');
    marks().fail(S, 'n1', op, { key: 'canvas.upload.failed' });
    marks().answer(S, 'n1', op);
    expect(marks().markOf(S, 'n1')?.state).toBe('failed');
  });

  it('clears a failure line, and leaves a waiting operation its mark', () => {
    const failed = marks().begin(S, 'n1', 'upload');
    marks().fail(S, 'n1', failed, { key: 'canvas.upload.failed' });
    marks().clearFailed(S, 'n1');
    expect(marks().markOf(S, 'n1')).toBeUndefined();
    const waiting = marks().begin(S, 'n2', 'upload');
    marks().clearFailed(S, 'n2');
    expect(marks().markOf(S, 'n2')).toEqual({ op: waiting, state: 'waiting', action: 'upload', at: NOW });
  });

  it('keeps each Space and node apart', () => {
    marks().begin(S, 'n1', 'upload');
    expect(marks().markOf(S, 'n2')).toBeUndefined();
    expect(marks().markOf('space-2', 'n1')).toBeUndefined();
  });
});
