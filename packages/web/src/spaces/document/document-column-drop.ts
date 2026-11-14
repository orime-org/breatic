// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Landing a dragged row beside another to make or grow a column group
 * (inner#1314 design §5.2).
 *
 * The move is two transactions, the take-away and then the put-down. Yjs has
 * no move, and y-prosemirror's `updateYFragment` matches a changed list of
 * children by identity from both ends and rewrites the middle in place by
 * position (`sync-plugin.js` `updateYFragment`); a transaction that only
 * deletes, or only inserts, keeps every untouched column and every block in
 * between on its own Yjs element, so words a collaborator types there stay.
 * The two land in one undo step: the undo manager merges changes made within
 * its capture timeout.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import { docNameOf } from '@web/data/yjs/manager';
import { checkAdd } from '@web/data/yjs/space-write';
import { DOC_COLUMN, DOC_COLUMN_LIST, meanWeight, weightsOf } from '@web/spaces/document/document-column-geometry';
import { COLUMN_TAKE_AWAY } from '@web/spaces/document/document-column-repair';
import { rangeToLift } from '@web/spaces/document/document-drag-move';
import { rowById, type RowInDocument } from '@web/spaces/document/document-row-by-id';

/** Which side of the target the row lands on. */
export type ColumnSide = 'left' | 'right';

/** A row's column and group, when it stands directly in a column. */
interface InColumn {
  /** The group's start. */
  readonly groupPos: number;
  /** The group. */
  readonly group: PMNode;
  /** The column's index in the group. */
  readonly index: number;
  /** The column. */
  readonly column: PMNode;
}

/**
 * The column a row stands directly in.
 * @param $row - The position before the row.
 * @returns Its column and group, or null.
 */
export function columnAround($row: ResolvedPos): InColumn | null {
  if ($row.parent.type.name !== DOC_COLUMN || $row.depth < 2) return null;
  const group = $row.node($row.depth - 1);
  if (group.type.name !== DOC_COLUMN_LIST) return null;
  return { groupPos: $row.before($row.depth - 1), group, index: $row.index($row.depth - 1), column: $row.parent };
}

/**
 * Whether landing the row there leaves the layout as it is: the row is alone
 * in its column and lands on the near side of the next column.
 * @param doc - The document.
 * @param dragged - The dragged row.
 * @param target - The target row.
 * @param side - The side.
 * @returns True when nothing would change.
 */
export function landsInPlace(doc: PMNode, dragged: RowInDocument, target: RowInDocument, side: ColumnSide): boolean {
  const from = columnAround(doc.resolve(dragged.from));
  const to = columnAround(doc.resolve(target.from));
  if (from === null || to === null || from.groupPos !== to.groupPos || from.column.childCount !== 1) return false;
  return side === 'left' ? to.index === from.index + 1 : to.index === from.index - 1;
}

/**
 * Lands a row beside a target row: wraps the two in a new group, or adds a
 * column to the target's group.
 * @param editor - The editor.
 * @param draggedId - The dragged row's id.
 * @param targetId - The target row's id.
 * @param side - Which side of the target.
 * @returns Whether anything was written.
 */
export function dropRowBeside(
  editor: BlockNoteEditor<never, never, never>,
  draggedId: string,
  targetId: string,
  side: ColumnSide,
): boolean {
  const view = editor.prosemirrorView;
  const before = view.state.doc;
  const dragged = rowById(before, draggedId);
  const target = rowById(before, targetId);
  if (dragged === undefined || target === undefined) return false;
  if (target.from >= dragged.from && target.to <= dragged.to) return false;
  if (landsInPlace(before, dragged, target, side)) return false;
  // The move is two transactions; the gate is asked once before the first,
  // so a Space that cannot take the put-down never has the take-away written
  // alone (design 5.2, as `refusedForSize` asks before a proposal lands).
  const ydoc = (ySyncPluginKey.getState(view.state) as { doc?: Y.Doc } | undefined)?.doc ?? null;
  const name = docNameOf(ydoc);
  if (name !== null && !checkAdd(name).ok) return false;
  const fromGroup = columnAround(before.resolve(dragged.from));
  const toGroup = columnAround(before.resolve(target.from));
  const sameGroup = fromGroup !== null && toGroup !== null && fromGroup.groupPos === toGroup.groupPos;

  // A nested child leaves with its group when it is the group's only child.
  const leaving = rangeToLift(before, dragged);
  const take = view.state.tr.delete(leaving.from, leaving.to);
  if (sameGroup) take.setMeta(COLUMN_TAKE_AWAY, true);
  view.dispatch(take);

  const { schema } = view.state;
  const columnType = schema.nodes[DOC_COLUMN]!;
  const listType = schema.nodes[DOC_COLUMN_LIST]!;
  const tr = view.state.tr;
  let landing = rowById(tr.doc, targetId);
  if (landing === undefined) return true;
  let around = columnAround(tr.doc.resolve(landing.from));
  if (around !== null && around.group.childCount === 1 && !sameGroup) {
    // A group a merge left with one column: it dissolves, and the target is
    // wrapped on its own.
    tr.replaceWith(around.groupPos, around.groupPos + around.group.nodeSize, around.column.content);
    landing = rowById(tr.doc, targetId)!;
    around = null;
  }
  if (around !== null) {
    const $column = tr.doc.resolve(landing.from);
    const column = columnType.create({ width: meanWeight(weightsOf(around.group)) }, dragged.node);
    tr.insert(side === 'left' ? $column.before() : $column.after(), column);
  } else {
    const ours = columnType.create({ width: 1 }, landing.node);
    const theirs = columnType.create({ width: 1 }, dragged.node);
    tr.replaceWith(landing.from, landing.to, listType.create(null, side === 'left' ? [theirs, ours] : [ours, theirs]));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}
