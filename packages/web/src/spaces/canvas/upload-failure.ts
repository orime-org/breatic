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
      /**
       * The bytes never reached the edge, so the finish was never asked for and
       * the server was never told (#237). Nobody else is going to end this row,
       * which makes reporting it the whole of what the browser owes here.
       *
       * It carries no sentence on purpose. A toast is gone by the time someone
       * who started an upload and looked away comes back, and a node now runs
       * several uploads at once — so what they read is the row itself, under
       * the node's failed count, whenever they open it.
       */
      readonly kind: 'reportToServer';
      /** The row to report against, and to keep the File under for its Retry. */
      readonly taskId: string;
    }
  | {
      readonly kind: 'serverKnows';
      readonly taskId: string;
      /**
       * The task to keep the File under, when keeping it is worth anything.
       *
       * Absent when the failure is about the bytes rather than about this
       * attempt: the same file re-sent meets the same answer, so offering a
       * Retry would contradict the sentence beside it.
       */
      readonly keepFileFor?: string;
      readonly toastKey: string;
      readonly severity: UploadFailureSeverity;
    }
  | {
      readonly kind: 'nobodyKnows';
      readonly toastKey: string;
      readonly severity: UploadFailureSeverity;
    };

/**
 * How loudly the toast says it.
 *
 * The colour a toast carries is its severity, and the reader cannot see which
 * gate caught their file: a format we do not take is the same refusal whether
 * the browser or the edge said so, and it reaches the screen under the same
 * sentence either way.
 */
export type UploadFailureSeverity = 'warning' | 'error';

/**
 * The refusals a warning states: the file is turned down for what it is, so
 * choosing another one is the whole of the remedy.
 */
const REFUSALS: ReadonlySet<UploadFailure['reason']> = new Set([
  'unsupportedType',
]);

/** The sentence each reason needs, keyed by what the reader should do next. */
const TOAST_KEY: Readonly<Record<UploadFailure['reason'], string>> = {
  // Nobody frees room in the seconds a retry takes.
  storage: 'canvas.upload.storageFull',
  // The hashing worker is what broke; the remedy is a reload.
  hash: 'canvas.upload.hashUnavailable',
  // The bytes are not a kind we keep, which re-sending them does not change.
  unsupportedType: 'canvas.upload.unsupportedType',
  upload: 'canvas.upload.failed',
  // Reached only by a transfer with no task row — the focus-crop lane, which
  // gets a ticket without a node. One with a row reports instead, and never
  // arrives here.
  transfer: 'canvas.upload.failed',
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
  if (outcome.reason === 'transfer' && outcome.taskId !== undefined) {
    return { kind: 'reportToServer', taskId: outcome.taskId };
  }
  const toastKey = TOAST_KEY[outcome.reason];
  const severity: UploadFailureSeverity = REFUSALS.has(outcome.reason)
    ? 'warning'
    : 'error';
  if (outcome.taskId !== undefined) {
    return {
      kind: 'serverKnows',
      taskId: outcome.taskId,
      severity,
      // Only the catch-all is about this attempt. Every named reason is about
      // the file or the account, and re-sending meets the same answer.
      ...(outcome.reason === 'upload' && { keepFileFor: outcome.taskId }),
      toastKey,
    };
  }
  return { kind: 'nobodyKnows', toastKey, severity };
}
