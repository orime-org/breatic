// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the browser does with an upload that ended badly (#186 §3.7.3).
 *
 * The dividing line is whether the ticket was granted. Past it the server
 * holds a task row and a timer that will judge it, so the row is going to get
 * an ending without the browser saying anything — all the browser owes is the
 * person who tried: tell them, and keep their File so the row's own Retry can
 * use it. Before it, nothing on the server ever heard of this upload, so
 * nobody is coming to end it and the empty node this drop created has no
 * future at all.
 */

import { describe, it, expect } from 'vitest';

import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';

describe('resolveUploadFailure', () => {
  it('keeps the File under the task when the server has a row for it', () => {
    const plan = resolveUploadFailure({ reason: 'upload', taskId: 't-1' });

    expect(plan).toEqual({
      kind: 'serverKnows',
      taskId: 't-1',
      toastKey: 'canvas.upload.failed',
    });
  });

  it('says nobody knows when the ticket was never granted', () => {
    const plan = resolveUploadFailure({ reason: 'upload' });

    expect(plan).toEqual({
      kind: 'nobodyKnows',
      toastKey: 'canvas.upload.failed',
    });
  });

  it('names a full account by its own remedy', () => {
    // Nobody frees room in the seconds a retry takes, so the sentence has to
    // be the one about the account rather than the one about trying again.
    expect(resolveUploadFailure({ reason: 'storage' })).toEqual({
      kind: 'nobodyKnows',
      toastKey: 'canvas.upload.storageFull',
    });
  });

  it('names a file that could not be fingerprinted by its own remedy', () => {
    // The hashing worker is what broke, so no retry on this page can succeed
    // and the remedy is a reload.
    expect(resolveUploadFailure({ reason: 'hash' })).toEqual({
      kind: 'nobodyKnows',
      toastKey: 'canvas.upload.hashUnavailable',
    });
  });

  it('tells the person who tried, whichever side of the ticket it failed on', () => {
    // Whether a row exists decides who ends the task, not whether the user
    // hears about it.
    const both = [
      resolveUploadFailure({ reason: 'upload', taskId: 't-1' }),
      resolveUploadFailure({ reason: 'upload' }),
    ];

    for (const plan of both) expect(plan.toastKey).toBe('canvas.upload.failed');
  });
});
