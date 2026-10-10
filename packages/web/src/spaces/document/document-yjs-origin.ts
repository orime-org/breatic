// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';

/**
 * Whether a transaction is a change that came in through Yjs.
 * @param tr - The transaction.
 * @returns True for a peer's edit, an undo, or anything else the binding
 *   writes into the body.
 */
export function fromYjs(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return sync?.isChangeOrigin === true;
}

/**
 * Whether a transaction is the reader's own undo or redo.
 * @param tr - The transaction.
 * @returns True when the binding writes an undo or redo into the body.
 */
export function undoRedo(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean } | undefined;
  return sync?.isUndoRedoOperation === true;
}
