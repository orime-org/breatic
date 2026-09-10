// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a task row offers the reader (#186 §7.1).
 *
 * Two of the six rows in that table are conditional, and each condition comes
 * from somewhere the row itself cannot see: whether this session still holds
 * the File (§3.7.2), and whether the task left a result behind (§3.3). Both
 * are passed in, so the rule is one table with no lookups in it.
 */

import { describe, it, expect } from 'vitest';

import { taskRowActions } from '@web/spaces/canvas/tasks/task-row-actions';

describe('taskRowActions', () => {
  it('offers nothing on a task that is still running', () => {
    // Nothing about it is settled, so every button would act on a moving
    // target.
    expect(
      taskRowActions({
        status: 'running',
        hasResult: false,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual([]);
  });

  it('offers writing the result onto the node, then finishing, when it is done', () => {
    expect(
      taskRowActions({
        status: 'done',
        hasResult: true,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual(['replace', 'finish']);
  });

  it('drops the write when a done task left no result to write', () => {
    expect(
      taskRowActions({
        status: 'done',
        hasResult: false,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual(['finish']);
  });

  it('offers a retry on a failed upload whose File this session still holds', () => {
    expect(
      taskRowActions({
        status: 'failed',
        hasResult: false,
        hasRetryFile: true,
        readOnly: false,
      }),
    ).toEqual(['retry', 'clear']);
  });

  it('offers only clearing on a failure with no File behind it', () => {
    // A generation has no file to re-send, and an upload loses its stash on
    // reload — both land here.
    expect(
      taskRowActions({
        status: 'failed',
        hasResult: false,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual(['clear']);
  });

  it('offers only clearing on an expired task that produced nothing', () => {
    expect(
      taskRowActions({
        status: 'expired',
        hasResult: false,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual(['clear']);
  });

  it('offers the late result on an expired task whose report arrived after the verdict', () => {
    // §4.5: the work finished, only too late to be counted. The bytes are
    // real, so the reader gets to put them on the node.
    expect(
      taskRowActions({
        status: 'expired',
        hasResult: true,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual(['replace', 'clear']);
  });

  it('never offers a retry outside a failure', () => {
    // The stash is keyed by task and outlives the task's own state, so a
    // stashed File must not turn into a button on a row that succeeded.
    for (const status of ['running', 'done', 'expired'] as const) {
      expect(
        taskRowActions({
          status,
          hasResult: true,
          hasRetryFile: true,
          readOnly: false,
        }),
      ).not.toContain('retry');
    }
  });

  it('never offers a write on a failure, even one that somehow carries a result', () => {
    expect(
      taskRowActions({
        status: 'failed',
        hasResult: true,
        hasRetryFile: true,
        readOnly: false,
      }),
    ).toEqual(['retry', 'clear']);
  });
});

describe('a reader who cannot write', () => {
  // B4 lets a read-only member open the list: the tasks on a node are part of
  // looking at it. Every button on a row is a write, and each one refuses in
  // its own way — Replace returns a noop with nothing said, Clear reaches the
  // server for a 403. A row offers them nothing instead.
  it('offers no buttons on any settled row', () => {
    for (const status of ['done', 'failed', 'expired'] as const) {
      expect(
        taskRowActions({
          status,
          hasResult: true,
          hasRetryFile: true,
          readOnly: true,
        }),
      ).toEqual([]);
    }
  });

  it('still offers them to a member who can write', () => {
    expect(
      taskRowActions({
        status: 'done',
        hasResult: true,
        hasRetryFile: false,
        readOnly: false,
      }),
    ).toEqual(['replace', 'finish']);
  });
});
