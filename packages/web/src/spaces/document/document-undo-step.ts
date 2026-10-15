// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which edits are an undo step of their own (inner#1351 + inner#1390 design
 * §5.5, A6): a paste, a drop, and an insert the body's own entries make —
 * files, a canvas clipboard, the insert menu's media. Typing next to them,
 * however soon, is a step apart.
 *
 * A paste or a drop is one by its event, whichever hook writes it — files,
 * a canvas clipboard and web content alike; the undo extension closes the
 * step around the event. An insert made outside one is marked with
 * {@link markOwnUndoStep}: the insert menu's media, and the media a paste in
 * a table cell lands under the table once its event is done.
 */

import type { Transaction } from '@tiptap/pm/state';

/** The meta the body's own entries mark an insert with. */
const OWN_UNDO_STEP = 'documentOwnUndoStep';

/**
 * Marks a transaction as an undo step of its own.
 * @param tr - The transaction.
 * @returns The same transaction.
 */
export function markOwnUndoStep(tr: Transaction): Transaction {
  return tr.setMeta(OWN_UNDO_STEP, true);
}

/**
 * Whether a transaction is a marked insert.
 * @param tr - The transaction.
 * @returns True for a marked insert that changes the document.
 */
export function isOwnUndoStep(tr: Transaction): boolean {
  return tr.docChanged && tr.getMeta(OWN_UNDO_STEP) === true;
}
