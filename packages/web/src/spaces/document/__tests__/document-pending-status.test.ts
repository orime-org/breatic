// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a pending media block shows, row by row of the display table in the
 * inner#1351 design §5.5: the uploader's own page, a collaborator who sees a
 * claim, and anyone when nobody claims the upload.
 */

import { describe, it, expect } from 'vitest';

import { claimIn, pendingStatus } from '@web/spaces/document/document-pending-status';

const FAILURE = { messageKey: 'canvas.upload.failed', params: {}, retryable: true };

describe('on the uploader\'s page', () => {
  it('in flight: uploading, with its progress', () => {
    expect(
      pendingStatus({ entry: { phase: 'uploading', progress: 0.42 }, access: 'granted', refused: false, claim: null }),
    ).toEqual({ kind: 'uploading', progress: 0.42 });
  });

  it('failed: the failure, which says whether a retry can help', () => {
    expect(
      pendingStatus({ entry: { phase: 'failed', failure: FAILURE }, access: 'granted', refused: false, claim: null }),
    ).toEqual({ kind: 'failed', failure: FAILURE });
  });

  it('done while the page may write: still uploading until the write lands', () => {
    expect(
      pendingStatus({ entry: { phase: 'done', result: { url: 'https://cdn.example/x.png' } }, access: 'granted', refused: false, claim: null }),
    ).toEqual({ kind: 'uploading', progress: null });
  });

  it('done on a page demoted to read-only: waiting for write access', () => {
    expect(
      pendingStatus({ entry: { phase: 'done', result: { url: 'https://cdn.example/x.png' } }, access: 'denied', refused: false, claim: null }),
    ).toEqual({ kind: 'waitingDemoted' });
  });

  it('done on a page the server refused: uploaded, not yet in the body', () => {
    expect(
      pendingStatus({ entry: { phase: 'done', result: { url: 'https://cdn.example/x.png' } }, access: 'denied', refused: true, claim: null }),
    ).toEqual({ kind: 'waitingRefused' });
  });
});

describe('on a page that did not run the upload', () => {
  it('claimed as uploading: uploading', () => {
    expect(pendingStatus({ entry: undefined, access: 'granted', refused: false, claim: 'uploading' })).toEqual({
      kind: 'peerUploading',
    });
  });

  it('claimed as failed: upload failed', () => {
    expect(pendingStatus({ entry: undefined, access: 'granted', refused: false, claim: 'failed' })).toEqual({
      kind: 'peerFailed',
    });
  });

  it('claimed by nobody: upload not finished', () => {
    expect(pendingStatus({ entry: undefined, access: 'granted', refused: false, claim: null })).toEqual({
      kind: 'notFinished',
    });
  });
});

describe('reading a claim out of awareness', () => {
  const states = new Map<number, Record<string, unknown>>([
    [1, { user: { name: 'a' } }],
    [2, { uploads: { u1: 'failed', u2: 'uploading' } }],
    [3, { uploads: { u1: 'uploading' } }],
    [4, { uploads: 'not a map' }],
  ]);

  it('any client claiming it as uploading wins over a failed one', () => {
    expect(claimIn(states, 'u1')).toBe('uploading');
  });

  it('a single failed claim reads as failed', () => {
    expect(claimIn(new Map([[2, { uploads: { u1: 'failed' } }]]), 'u1')).toBe('failed');
  });

  it('no client claiming it reads as null, and malformed states are ignored', () => {
    expect(claimIn(states, 'u9')).toBeNull();
  });
});
