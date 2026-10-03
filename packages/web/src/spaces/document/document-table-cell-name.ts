// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Holding on to one table cell while co-editors change the document.
 *
 * A table menu and a row or column drag both act on the cell they started
 * from, and both stay open while others edit. The reader's own edits carry
 * the cell by `tr.mapping`. A change that comes in through Yjs cannot: the
 * binding lands it as one replacement of the whole body
 * (`y-prosemirror` `_typeChanged`), and that mapping reports every position
 * as deleted — so a peer typing a letter anywhere would close the menu and
 * end the drag.
 *
 * Across such a change the cell is found by the Yjs element it is bound to.
 * The binding keeps the element's node when the element did not change and
 * builds a new one when it did (a peer typing into the cell), and in both
 * cases records it against the element before it dispatches; the element's
 * item is deleted exactly when a peer deleted the cell, its row, or its
 * table. This is the same index `y-prosemirror` resolves relative positions
 * through.
 *
 * The element is taken again after every change to the body, from the view's
 * `update`: the sync plugin's view writes the reader's own edit into Yjs
 * before ours runs, and a command that rebuilt the cell leaves it bound to a
 * new element.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type * as Y from 'yjs';

import { syncBindingOf } from '@web/spaces/document/document-link-tracking';
import { cellAt } from '@web/spaces/document/document-table-run';

/** The Yjs element a cell is bound to. */
export type CellName = Y.AbstractType<unknown>;

/**
 * Names the cell at a position by its Yjs element.
 * @param state - The state the position belongs to, in step with Yjs.
 * @param cellPos - The position before the cell.
 * @returns The element, or null when the editor is not bound or the cell is
 *   not in it yet.
 */
export function nameCell(state: EditorState, cellPos: number): CellName | null {
  const bound = syncBindingOf(state);
  const node = state.doc.nodeAt(cellPos);
  if (bound === null || node === null) return null;
  for (const [type, mapped] of bound.mapping) {
    if (mapped === node) return type;
  }
  return null;
}

/**
 * Finds a named cell in a document the binding has just built.
 * @param state - A state carrying the sync binding.
 * @param doc - The document to look in.
 * @param name - The cell's element.
 * @returns The position before the cell, or null once it is gone.
 */
export function cellNamed(state: EditorState, doc: PMNode, name: CellName): number | null {
  const bound = syncBindingOf(state);
  const item = name._item;
  if (bound === null || item === null || item.deleted) return null;
  const node = bound.mapping.get(name);
  if (node === undefined || Array.isArray(node)) return null;
  let found: number | null = null;
  doc.descendants((child, pos) => {
    if (found !== null) return false;
    if (child === node) found = pos;
    return found === null;
  });
  return found !== null && cellAt(doc, found) !== null ? found : null;
}
