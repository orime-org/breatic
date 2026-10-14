// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which edits are an undo step of their own (inner#1351 + inner#1390 design
 * §5.5, A6): a paste, a drop, and an insert the body's own entries make —
 * files, a canvas clipboard, the insert menu's media. Typing next to them,
 * however soon, is a step apart.
 *
 * ProseMirror marks its own paste and drop with the `uiEvent` meta
 * (`prosemirror-view` `doPaste`, `handleDrop`); the body's entries mark
 * theirs with {@link markOwnUndoStep}. The undo extension reads both.
 */

import type { Transaction } from '@tiptap/pm/state';

/** The meta the body's own entries mark an insert with. */
const OWN_UNDO_STEP = 'documentOwnUndoStep';

/** The `uiEvent` values ProseMirror gives its paste and drop. */
const OWN_STEP_EVENTS: ReadonlySet<unknown> = new Set(['paste', 'drop']);

/**
 * Marks a transaction as an undo step of its own.
 * @param tr - The transaction.
 * @returns The same transaction.
 */
export function markOwnUndoStep(tr: Transaction): Transaction {
  return tr.setMeta(OWN_UNDO_STEP, true);
}

/**
 * Whether a transaction is an undo step of its own.
 * @param tr - The transaction.
 * @returns True for a paste, a drop, or a marked insert that changes the document.
 */
export function isOwnUndoStep(tr: Transaction): boolean {
  return tr.docChanged && (tr.getMeta(OWN_UNDO_STEP) === true || OWN_STEP_EVENTS.has(tr.getMeta('uiEvent')));
}
