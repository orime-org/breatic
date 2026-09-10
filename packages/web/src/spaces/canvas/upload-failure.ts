// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the browser does with an upload that ended badly (#186 §3.7.3).
 *
 * Pure, so the rule is readable without a canvas: the caller performs the two
 * side effects (a toast, and either keeping the File or dropping the node it
 * created).
 */

import type { UploadFailure } from '@web/spaces/canvas/canvas-upload';

/**
 * What to do about a failed upload.
 *
 * `serverKnows` — the ticket was granted, so a task row exists, carrying its
 * own budget. That row reaches an end whatever the browser does; keeping the
 * File under its id is what lets the row's own Retry re-send it.
 *
 * `nobodyKnows` — the ticket never was. No row and no grant: nothing on the
 * server can end this, so the empty node this drop created has no future.
 */
export type UploadFailurePlan =
  | {
      readonly kind: 'serverKnows';
      readonly taskId: string;
      readonly toastKey: string;
    }
  | { readonly kind: 'nobodyKnows'; readonly toastKey: string };

/** The sentence each reason needs, keyed by what the reader should do next. */
const TOAST_KEY: Readonly<Record<UploadFailure['reason'], string>> = {
  // Nobody frees room in the seconds a retry takes.
  storage: 'canvas.upload.storageFull',
  // The hashing worker is what broke; the remedy is a reload.
  hash: 'canvas.upload.hashUnavailable',
  upload: 'canvas.upload.failed',
};

/**
 * Decide what a failed upload leaves behind.
 *
 * The person who tried is told either way — whether a row exists decides who
 * ends the task, not whether they hear about it.
 * @param outcome - How the upload ended, and whether it got a ticket.
 * @returns The plan its caller carries out.
 */
export function resolveUploadFailure(
  outcome: UploadFailure,
): UploadFailurePlan {
  const toastKey = TOAST_KEY[outcome.reason];
  if (outcome.taskId !== undefined) {
    return { kind: 'serverKnows', taskId: outcome.taskId, toastKey };
  }
  return { kind: 'nobodyKnows', toastKey };
}
