// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Keeping comment highlights off the undo stack (#18, A16).
 *
 * A comment is withdrawn through the card that holds it — Delete for the
 * whole thread, Resolve to settle it — and both take its highlight away. That
 * is the way back, so Cmd+Z is not one: a reader pressing it is reaching for
 * the last thing they wrote, and a highlight is not it (user 2026-09-22).
 *
 * Which makes this one rule rather than two. Both kinds of write to a comment
 * mark are a transaction of nothing but comment mark steps:
 *
 * - the reader opening a comment, marking the words they selected;
 * - the library rewriting `orphan` for every mark of a thread that was
 *   resolved, deleted or lost its text (`updateMarksFromThreads`, called from
 *   the thread store's subscription, `comments/extension.ts:130-173`).
 *
 * Neither belongs on the stack, so neither needs telling apart. What made the
 * second one urgent stays true: it runs on a PEER's resolve as a local
 * transaction here, and captured, it would hand the reader's Cmd+Z somebody
 * else's highlight change instead of their own last edit.
 *
 * Posting also writes the thread itself into its map, and that write is out
 * of this stack's scope to begin with — `createDocumentUndo` scopes the
 * manager to the body fragment. So neither half of posting is undoable, and
 * there is no half-taken-back state where the highlight goes and the thread
 * stays.
 */

import type { Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';

/** The mark's name on the schema, as the library registers it. */
const COMMENT_MARK = 'comment';

/**
 * Whether one step only puts a comment mark on or takes one off.
 * @param step - A step from the transaction.
 * @returns True for a comment mark step, false for anything else.
 */
function isCommentMarkStep(step: Transaction['steps'][number]): boolean {
  if (!(step instanceof AddMarkStep) && !(step instanceof RemoveMarkStep)) {
    return false;
  }
  return step.mark.type.name === COMMENT_MARK;
}

/**
 * Whether this transaction does nothing but move comment highlights.
 * @param tr - The transaction being applied.
 * @returns True for a non-empty transaction of comment mark steps alone.
 */
export function isCommentMarkWrite(tr: Transaction): boolean {
  // An empty transaction has no steps, and "every step is a comment mark
  // step" is vacuously true of an empty list — which would read a bare
  // selection change as one of these.
  if (tr.steps.length === 0) return false;
  return tr.steps.every(isCommentMarkStep);
}
