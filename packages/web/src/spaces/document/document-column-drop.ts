// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Landing a dragged row beside another to make or grow a column group
 * (inner#1314 design §5.2).
 *
 * The move is two transactions, the put-down and then the take-away. Yjs has
 * no move, and y-prosemirror's `updateYFragment` matches a changed list of
 * children by identity from both ends and rewrites the middle in place by
 * position (`sync-plugin.js` `updateYFragment`); a transaction that only
 * inserts, or only deletes, keeps every untouched column and every block in
 * between on its own Yjs element, so words a collaborator types there stay.
 * Putting down first means a group never stands with one column in between:
 * a collaborator's own repair would dissolve it (§5.1), and the put-down
 * would then land in a group that is gone.
 *
 * The copy put down carries the row's ids, and the put-down marks the
 * original's ids as moving: a collaborator's editor reads a remote change as
 * one change over the whole document, and BlockNote's `UniqueID` renews an id
 * that repeats inside one change, so two rows carrying one id there would
 * cost the moved row its id. The take-away deletes the marked original.
 * The two land in one undo step: the undo manager merges changes made within
 * its capture timeout.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import { Fragment, Node as PMNode, Slice, type ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep } from '@tiptap/pm/transform';
import type * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import { docNameOf } from '@web/data/yjs/manager';
import { checkAdd } from '@web/data/yjs/space-write';
import { DOC_COLUMN, DOC_COLUMN_LIST, meanWeight, weightsOf } from '@web/spaces/document/document-column-geometry';
import { rangeToLift } from '@web/spaces/document/document-drag-move';
import { rowById, type RowInDocument } from '@web/spaces/document/document-row-by-id';

/** What the original's ids carry while the row is being moved. */
const MOVING = ':moving';

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
  // so a Space that cannot take the put-down writes neither (design 5.2, as
  // `refusedForSize` asks before a proposal lands).
  const ydoc = (ySyncPluginKey.getState(view.state) as { doc?: Y.Doc } | undefined)?.doc ?? null;
  const name = docNameOf(ydoc);
  if (name !== null && !checkAdd(name).ok) return false;
  const fromGroup = columnAround(before.resolve(dragged.from));
  let around = columnAround(before.resolve(target.from));
  const sameGroup = fromGroup !== null && around !== null && fromGroup.groupPos === around.groupPos;

  const { schema } = view.state;
  const columnType = schema.nodes[DOC_COLUMN]!;
  const listType = schema.nodes[DOC_COLUMN_LIST]!;
  const copy = PMNode.fromJSON(schema, dragged.node.toJSON());
  const put = view.state.tr;
  markMoving(put, dragged);
  let landing = target;
  if (around !== null && around.group.childCount === 1 && !sameGroup) {
    // A group a merge left with one column: it dissolves, its blocks lifted
    // out where they stand, and the target is wrapped on its own.
    const end = around.groupPos + around.group.nodeSize;
    put.step(new ReplaceAroundStep(around.groupPos, end, around.groupPos + 2, end - 2, Slice.empty, 0, true));
    landing = rowById(put.doc, targetId)!;
    around = null;
  }
  if (around !== null) {
    // A lone block moving within its group takes its column along.
    const leaving = sameGroup && fromGroup.column.childCount === 1 ? fromGroup.index : -1;
    const kept = weightsOf(around.group).filter((_weight, index) => index !== leaving);
    const $column = put.doc.resolve(landing.from);
    put.insert(side === 'left' ? $column.before() : $column.after(), columnType.create({ width: meanWeight(kept) }, copy));
  } else {
    // The target is wrapped where it stands, so everything inside it maps
    // through, a block nested under it included.
    const theirs = columnType.create({ width: 1 }, copy);
    const ours = columnType.create({ width: 1 });
    const list = listType.create(null, side === 'left' ? [theirs, ours] : [ours, theirs]);
    const gap = side === 'left' ? theirs.nodeSize + 2 : 2;
    put.step(new ReplaceAroundStep(landing.from, landing.to, landing.from, landing.to, new Slice(Fragment.from(list), 0, 0), gap, true));
  }
  view.dispatch(put);

  const original = rowById(view.state.doc, draggedId + MOVING);
  if (original === undefined) return true;
  // A nested child leaves with its group when it is the group's only child.
  const leaving = rangeToLift(view.state.doc, original);
  view.dispatch(view.state.tr.delete(leaving.from, leaving.to).scrollIntoView());
  return true;
}

/**
 * Marks the ids of a row and everything in it as moving. The marks change no
 * size, so positions stay.
 * @param tr - The transaction.
 * @param row - The row.
 */
function markMoving(tr: Transaction, row: RowInDocument): void {
  for (const [node, pos] of [[row.node, row.from] as const, ...descendantsOf(row)]) {
    const id: unknown = node.attrs['id'];
    if (typeof id === 'string' && id !== '') tr.setNodeAttribute(pos, 'id', id + MOVING);
  }
}

/**
 * Every node inside a row, with where it starts.
 * @param row - The row.
 * @returns The nodes.
 */
function descendantsOf(row: RowInDocument): (readonly [PMNode, number])[] {
  const nodes: (readonly [PMNode, number])[] = [];
  row.node.descendants((node, offset) => {
    nodes.push([node, row.from + 1 + offset]);
  });
  return nodes;
}
