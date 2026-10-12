// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The uploader's own marks on the nodes it is filling (inner#1303 §6.7): an
 * operation is waiting from the moment its node exists until the server
 * answers, or failed when it ends before that. Only the latest operation on a
 * node counts.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useUploadMarksStore } from '@web/stores/upload-marks';

const S = 'space-1';

/** The store's actions. */
const marks = () => useUploadMarksStore.getState();

beforeEach(() => {
  useUploadMarksStore.setState({ marks: {} });
});

describe('upload marks', () => {
  it('waits from the start and clears on the answer', () => {
    const op = marks().begin(S, 'n1');
    expect(marks().markOf(S, 'n1')).toEqual({ op, state: 'waiting' });
    marks().answer(S, 'n1', op);
    expect(marks().markOf(S, 'n1')).toBeUndefined();
  });

  it('keeps a failure with its message until the next start', () => {
    const op = marks().begin(S, 'n1');
    marks().fail(S, 'n1', op, { key: 'canvas.upload.failed' });
    expect(marks().markOf(S, 'n1')).toEqual({ op, state: 'failed', message: { key: 'canvas.upload.failed' } });
    const next = marks().begin(S, 'n1');
    expect(marks().markOf(S, 'n1')).toEqual({ op: next, state: 'waiting' });
  });

  it('drops an answer or a failure from an operation a later start replaced', () => {
    const first = marks().begin(S, 'n1');
    const second = marks().begin(S, 'n1');
    marks().answer(S, 'n1', first);
    marks().fail(S, 'n1', first, { key: 'canvas.upload.failed' });
    expect(marks().markOf(S, 'n1')).toEqual({ op: second, state: 'waiting' });
  });

  it('drops an answer that reaches a failed mark', () => {
    const op = marks().begin(S, 'n1');
    marks().fail(S, 'n1', op, { key: 'canvas.upload.failed' });
    marks().answer(S, 'n1', op);
    expect(marks().markOf(S, 'n1')?.state).toBe('failed');
  });

  it('keeps each Space and node apart', () => {
    marks().begin(S, 'n1');
    expect(marks().markOf(S, 'n2')).toBeUndefined();
    expect(marks().markOf('space-2', 'n1')).toBeUndefined();
  });
});
