// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling the library's orphan sync from a reader's own comment (#18, A16).
 *
 * When a thread is resolved, deleted or gone, the library walks the body and
 * rewrites every mark carrying that thread id so its `orphan` attribute
 * agrees — `updateMarksFromThreads`, called from the thread store's
 * subscription. It goes through `editor.transact` and sets NO meta
 * (`comments/extension.ts:130-173` has no `setMeta`), so it satisfies all
 * three conditions this Space uses for "the reader's own edit": the doc
 * changed, nothing appended it, and it is not the sync binding.
 *
 * Left alone it therefore lands on the undo stack, and a reader pressing
 * Cmd+Z right after a PEER resolved a thread takes back that peer's highlight
 * change instead of their own last edit. §5.1.1 puts machine-derived
 * decorative syncs off the stack, and design §9.3 has the transition table.
 *
 * ## Why the step shape is not enough on its own
 *
 * A reader opening a comment writes a comment mark over the selected words,
 * and that is a transaction of nothing but comment mark steps — exactly what
 * the sync looks like. It is the reader's edit and Cmd+Z has to take it back,
 * so a predicate reading only the steps would push their own comment off the
 * stack too.
 *
 * So the second half is a meta neither side can get wrong: every write this
 * Space makes to a comment mark carries {@link DOCUMENT_COMMENT_WRITE}, and
 * the library's sync carries no meta at all. Absence is the signal.
 */

import type { Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';

/** The mark's name on the schema, as the library registers it. */
const COMMENT_MARK = 'comment';

/**
 * The meta every comment-mark write of ours carries.
 *
 * Its only job is to be absent from the library's own sync, which sets no
 * meta — so this says "a reader asked for this", and its absence on a
 * transaction of pure comment mark steps says the library did it.
 */
export const DOCUMENT_COMMENT_WRITE = 'documentCommentWrite';

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
 * Whether this transaction is the library rewriting orphan flags.
 * @param tr - The transaction being applied.
 * @returns True only for the library's sync — a non-empty transaction of
 *   comment mark steps that nothing in this Space asked for.
 */
export function isCommentOrphanSync(tr: Transaction): boolean {
  // An empty transaction has no steps, and "every step is a comment mark
  // step" is vacuously true of an empty list — which would read a bare
  // selection change as the sync.
  if (tr.steps.length === 0) return false;
  if (tr.getMeta(DOCUMENT_COMMENT_WRITE) === true) return false;
  return tr.steps.every(isCommentMarkStep);
}
