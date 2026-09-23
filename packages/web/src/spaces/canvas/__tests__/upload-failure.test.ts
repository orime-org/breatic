// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the browser does with an upload that ended badly (#186 §3.7.3).
 *
 * One plan reports and the rest only speak. A transfer that died before the
 * edge saw the bytes leaves a row nobody else will end, so it is reported;
 * every other failure is said in a toast, and keeps the File only where a
 * Retry can end differently. The node stays in all of them — a node that
 * exists is the reader's to remove, and only theirs (#2177).
 */

import { describe, it, expect } from 'vitest';

import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';

/**
 * The plan for a failure the browser says rather than reports.
 *
 * Narrowing here is the assertion: a reason that started reporting would stop
 * carrying a sentence, and these cases are about which sentence it carries.
 * @param outcome - How the upload ended.
 * @returns The plan, proven to be one that speaks.
 * @throws {Error} When this reason reports instead.
 */
function spoken(
  outcome: Parameters<typeof resolveUploadFailure>[0],
): Exclude<ReturnType<typeof resolveUploadFailure>, { kind: 'reportToServer' }> {
  const plan = resolveUploadFailure(outcome);
  if (plan.kind === 'reportToServer') {
    throw new Error(`${outcome.reason} reports rather than speaks`);
  }
  return plan;
}

describe('resolveUploadFailure', () => {
  it('keeps the File under the task when the server has a row for it', () => {
    const plan = resolveUploadFailure({ reason: 'upload', taskId: 't-1' });

    expect(plan).toEqual({
      kind: 'toastOnly',
      keepFileFor: 't-1',
      toastKey: 'canvas.upload.failed',
      severity: 'error',
    });
  });

  // Bytes that never reached the edge leave a row nobody else will end (#237):
  // the finish was never asked for, so the server was never told. This is the
  // one plan that reports, and it carries no sentence — what the reader sees is
  // the row itself, in the failed count, where it survives them looking away.
  it('reports a transfer that never landed, and keeps its File', () => {
    expect(resolveUploadFailure({ reason: 'transfer', taskId: 't-1' })).toEqual({
      kind: 'reportToServer',
      taskId: 't-1',
    });
  });

  it('keeps no File when the ticket was never granted', () => {
    const plan = resolveUploadFailure({ reason: 'upload' });

    expect(plan).toEqual({
      kind: 'toastOnly',
      toastKey: 'canvas.upload.failed',
      severity: 'error',
    });
  });

  it('keeps no file for a format the edge will refuse again', () => {
    // The row exists, so the server ends this one. What must not follow is a
    // Retry button: the same bytes meet the same refusal every time, and the
    // sentence beside it has to say so rather than "try again".
    expect(
      resolveUploadFailure({ reason: 'unsupportedType', taskId: 't-1' }),
    ).toEqual({
      kind: 'toastOnly',
      toastKey: 'canvas.upload.unsupportedType',
      severity: 'warning',
    });
  });

  it('names a full account by its own remedy', () => {
    // Nobody frees room in the seconds a retry takes, so the sentence has to
    // be the one about the account rather than the one about trying again.
    expect(resolveUploadFailure({ reason: 'storage' })).toEqual({
      kind: 'toastOnly',
      toastKey: 'canvas.upload.storageFull',
      severity: 'error',
    });
  });

  it('names a file that could not be fingerprinted by its own remedy', () => {
    // The hashing worker is what broke, so no retry on this page can succeed
    // and the remedy is a reload.
    expect(resolveUploadFailure({ reason: 'hash' })).toEqual({
      kind: 'toastOnly',
      toastKey: 'canvas.upload.hashUnavailable',
      severity: 'error',
    });
  });

  it('tells the person who tried, whichever side of the ticket it failed on', () => {
    // Whether a row exists decides who ends the task, not whether the user
    // hears about it.
    const both = [
      spoken({ reason: 'upload', taskId: 't-1' }),
      spoken({ reason: 'upload' }),
    ];

    for (const plan of both) expect(plan.toastKey).toBe('canvas.upload.failed');
  });

  it('warns for a refusal and errors for a breakdown', () => {
    // The colour a toast carries is its severity, and the reader cannot see
    // which gate caught the file. A format we do not take is the same refusal
    // whether the browser or the edge said so; a full studio, a broken hasher
    // and a transfer that died are failures of the attempt.
    expect(spoken({ reason: 'unsupportedType' }).severity).toBe('warning');
    expect(
      spoken({ reason: 'unsupportedType', taskId: 't-1' }).severity,
    ).toBe('warning');

    for (const reason of ['storage', 'hash', 'upload'] as const) {
      expect(spoken({ reason }).severity).toBe('error');
    }
  });
});
