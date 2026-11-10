// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a pending media block shows (inner#1351 + inner#1390 design §5.5): one
 * row of the display table, from what this page knows about the upload and
 * what other clients claim in awareness.
 */

import type { WriteAccess } from '@web/data/yjs/collab-socket';
import type { UploadClaim } from '@web/lib/upload-claims';
import type { UploadEntry, UploadFailure } from '@web/spaces/document/document-upload-controller';

/** What a pending block shows. */
export type PendingStatus =
  /** This page is running it; `progress` is the share sent when known. */
  | { readonly kind: 'uploading'; readonly progress: number | null }
  /** This page ran it and it failed. */
  | { readonly kind: 'failed'; readonly failure: UploadFailure }
  /** This page has the result and was demoted to read-only. */
  | { readonly kind: 'waitingDemoted' }
  /** This page has the result and the server refused it. */
  | { readonly kind: 'waitingRefused' }
  /** Another client claims it as uploading. */
  | { readonly kind: 'peerUploading' }
  /** Another client claims it as failed. */
  | { readonly kind: 'peerFailed' }
  /** Nobody claims it. */
  | { readonly kind: 'notFinished' };

/** What {@link pendingStatus} decides from. */
export interface PendingFacts {
  /** This page's record of the upload, if it ran it. */
  readonly entry: UploadEntry | undefined;
  /** This page's write access to the body. */
  readonly access: WriteAccess;
  /** Whether the server refused this page the body (the `authFailed` status). */
  readonly refused: boolean;
  /** What other clients claim. */
  readonly claim: UploadClaim | null;
}

/**
 * The row of the display table a pending block is in.
 * @param facts - What this page knows.
 * @returns What the block shows.
 */
export function pendingStatus(facts: PendingFacts): PendingStatus {
  const { entry } = facts;
  if (entry !== undefined) {
    if (entry.phase === 'failed') return { kind: 'failed', failure: entry.failure };
    if (entry.phase === 'done' && facts.access === 'denied') {
      return facts.refused ? { kind: 'waitingRefused' } : { kind: 'waitingDemoted' };
    }
    return { kind: 'uploading', progress: entry.phase === 'uploading' ? entry.progress : null };
  }
  if (facts.claim === 'uploading') return { kind: 'peerUploading' };
  if (facts.claim === 'failed') return { kind: 'peerFailed' };
  return { kind: 'notFinished' };
}
