// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Holding on to one table cell while co-editors change the document.
 *
 * A table menu and a row or column drag both act on the cell they started
 * from, and both stay open while others edit. The reader's own edits carry
 * the cell by `tr.mapping`, through the start of the cell's content: a change
 * to the cell's own attributes (a fill, an alignment, a header) rewrites the
 * token before the cell and keeps what is inside it, while deleting the cell,
 * its row or its table deletes that position too. A change that comes in
 * through Yjs cannot be mapped: the
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
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type * as Y from 'yjs';

import { syncBindingOf } from '@web/spaces/document/document-link-tracking';
import { cellAt } from '@web/spaces/document/document-table-run';
import { fromYjs } from '@web/spaces/document/document-yjs-origin';

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

/**
 * Where a held cell is after one transaction.
 * @param tr - The transaction.
 * @param before - The state it applies to, whose sync binding is the live one.
 * @param cellPos - The position before the cell, before the transaction.
 * @param name - The cell's Yjs element as of the last change to the body.
 * @returns The position before the cell after it, or null once it is gone.
 */
export function followCell(
  tr: Transaction,
  before: EditorState,
  cellPos: number,
  name: CellName | null,
): number | null {
  if (fromYjs(tr)) return name === null ? null : cellNamed(before, tr.doc, name);
  const inside = tr.mapping.mapResult(cellPos + 1, 1);
  if (inside.deleted) return null;
  const pos = inside.pos - 1;
  return cellAt(tr.doc, pos) === null ? null : pos;
}

/**
 * The held cell's Yjs element after a view update, taken again whenever the
 * body or the held cell changed.
 * @param state - The state now.
 * @param prev - The state before the update.
 * @param pos - The held cell now, or null when none is held.
 * @param prevPos - The held cell before the update.
 * @param name - The element taken last.
 * @returns The element to keep.
 */
export function renameCell(
  state: EditorState,
  prev: EditorState,
  pos: number | null,
  prevPos: number | null,
  name: CellName | null,
): CellName | null {
  if (pos === null) return null;
  if (state.doc === prev.doc && pos === prevPos && name !== null) return name;
  return nameCell(state, pos);
}
