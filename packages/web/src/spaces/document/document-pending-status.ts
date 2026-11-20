// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a pending media block shows (inner#1351 + inner#1390 design §5.5,
 * breatic#1574 design 3.6): one row of the display table, from what collab
 * wrote onto the block, what this page knows about the upload and what other
 * clients claim in awareness.
 */

import type { PendingFailureReason } from '@breatic/shared';

import type { WriteAccess } from '@web/data/yjs/collab-socket';
import type { UploadClaim } from '@web/lib/upload-claims';
import type { UploadEntry, UploadFailure } from '@web/spaces/document/document-upload-controller';

/** What a pending block shows. */
export type PendingStatus =
  /** This page is running it; `progress` is the share sent when known. */
  | { readonly kind: 'uploading'; readonly progress: number | null }
  /** This page ran it and it failed. */
  | { readonly kind: 'failed'; readonly failure: UploadFailure }
  /** The server has it and has not ended it. */
  | { readonly kind: 'processing' }
  /** The server ended it as failed, or it ran past its deadline; `retry` where this page holds the source and it can help. */
  | { readonly kind: 'serverFailed'; readonly failure: UploadFailure; readonly retry: boolean }
  /** This page has the result and was demoted to read-only. */
  | { readonly kind: 'waitingDemoted' }
  /** This page has the result and the server refused it. */
  | { readonly kind: 'waitingRefused' }
  /** This page has the result and the Space is full (inner#1790). */
  | { readonly kind: 'waitingFull' }
  /** Another client claims it as uploading. */
  | { readonly kind: 'peerUploading' }
  /** Another client claims it as failed. */
  | { readonly kind: 'peerFailed' }
  /** Nobody claims it. */
  | { readonly kind: 'notFinished' };

/** What collab wrote onto the block, and whether its upload belongs to another Document. */
export interface PendingBlockFacts {
  /** `processing` or `failed`, written by collab; empty before the server took the upload. */
  readonly state: '' | 'processing' | 'failed';
  /** Epoch ms after which a `processing` block reads as timed out. */
  readonly deadline?: number;
  readonly failure?: PendingFailureReason;
  readonly retryable?: boolean;
  /** The upload belongs to another Document: copied with its Project, it never ends here. */
  readonly foreign: boolean;
}

/** A block that ran past its deadline: the upload expired, which running it again can change. */
const TIMED_OUT: UploadFailure = { reason: 'failed', retryable: true };

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
  /** Whether the Space is full or over its ceiling, outside a rebuild. */
  readonly full?: boolean;
  /** What collab wrote onto the block; absent where the block is not read. */
  readonly block?: PendingBlockFacts;
  /** Now, in epoch ms, against the block's deadline. */
  readonly now?: number;
}

/**
 * The row of the display table a pending block is in.
 * @param facts - What this page knows.
 * @returns What the block shows.
 */
export function pendingStatus(facts: PendingFacts): PendingStatus {
  const { entry, block } = facts;
  if (block?.foreign === true) return { kind: 'notFinished' };
  // A page holds the source of an upload it ran and has not finished.
  const holdsSource = entry !== undefined && entry.phase !== 'done';
  if (block?.state === 'failed') {
    const failure: UploadFailure = { reason: block.failure ?? 'failed', retryable: block.retryable ?? true };
    return { kind: 'serverFailed', failure, retry: holdsSource && failure.retryable };
  }
  if (block?.state === 'processing') {
    if (block.deadline !== undefined && (facts.now ?? 0) > block.deadline) {
      return { kind: 'serverFailed', failure: TIMED_OUT, retry: holdsSource };
    }
    return { kind: 'processing' };
  }
  if (entry !== undefined) {
    if (entry.phase === 'handedOff') {
      // Until collab writes the block, the deadline the server named this page reads the same way the block's would.
      if (entry.deadline === undefined) return { kind: 'notFinished' };
      if ((facts.now ?? 0) > entry.deadline) return { kind: 'serverFailed', failure: TIMED_OUT, retry: holdsSource };
      return { kind: 'processing' };
    }
    if (entry.phase === 'failed') return { kind: 'failed', failure: entry.failure };
    if (entry.phase === 'done' && facts.access === 'denied') {
      return facts.refused ? { kind: 'waitingRefused' } : { kind: 'waitingDemoted' };
    }
    if (entry.phase === 'done' && facts.full === true) return { kind: 'waitingFull' };
    return { kind: 'uploading', progress: entry.phase === 'uploading' ? entry.progress : null };
  }
  if (facts.claim === 'uploading') return { kind: 'peerUploading' };
  if (facts.claim === 'failed') return { kind: 'peerFailed' };
  return { kind: 'notFinished' };
}
