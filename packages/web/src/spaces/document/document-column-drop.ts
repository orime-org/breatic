// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
 * would then land in a group that is gone. The copy put down carries the
 * row's ids; a collaborator's editor keeps them while it shows both copies,
 * as BlockNote's `UniqueID` leaves the ids of a remote change alone (patched,
 * as Tiptap's own `UniqueID` does).
 * The two land in one undo step: the undo manager merges changes made within
 * its capture timeout.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import { Fragment, Node as PMNode, Slice, type ResolvedPos } from '@tiptap/pm/model';
import { PluginKey } from '@tiptap/pm/state';
import { ReplaceAroundStep } from '@tiptap/pm/transform';
import type * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import { docNameOf } from '@web/data/yjs/manager';
import { checkAdd } from '@web/data/yjs/space-write';
import { DOC_COLUMN, DOC_COLUMN_LIST, meanWeight, weightsOf } from '@web/spaces/document/document-column-geometry';
import { liftOnlyColumn } from '@web/spaces/document/document-column-repair';
import { rangeToLift } from '@web/spaces/document/document-drag-move';
import { positionOf, rowById, type RowInDocument } from '@web/spaces/document/document-row-by-id';

/**
 * Meta on the put-down of a lone block's move within its group: the id of
 * the column the take-away empties, which the group to come leaves out.
 */
export const LEAVING_COLUMN = new PluginKey('doc-column-leaving');

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
  // A copy of its own: y-prosemirror pairs nodes with Yjs elements by identity.
  const copy = PMNode.fromJSON(schema, dragged.node.toJSON());
  const width = weightsAfterDrop(fromGroup, around).at(-1)!;
  const put = view.state.tr;
  let landing = target;
  if (around !== null && around.group.childCount === 1 && !sameGroup) {
    // A group a merge left with one column dissolves, and the target is
    // wrapped on its own.
    liftOnlyColumn(put, around.groupPos, around.group);
    landing = rowById(put.doc, targetId)!;
    around = null;
  }
  if (around !== null) {
    const $column = put.doc.resolve(landing.from);
    put.insert(side === 'left' ? $column.before() : $column.after(), columnType.create({ width }, copy));
    // The column the take-away empties is no column of the group to come.
    if (sameGroup && fromGroup.column.childCount === 1) put.setMeta(LEAVING_COLUMN, String(fromGroup.column.attrs['id']));
  } else {
    // The target is wrapped where it stands, so everything inside it maps
    // through, a block nested under it included.
    const moved = columnType.create({ width }, copy);
    const targets = columnType.create({ width });
    const list = listType.create(null, side === 'left' ? [moved, targets] : [targets, moved]);
    const gap = side === 'left' ? moved.nodeSize + 2 : 2;
    put.step(new ReplaceAroundStep(landing.from, landing.to, landing.from, landing.to, new Slice(Fragment.from(list), 0, 0), gap, true));
  }
  const mapped = put.mapping.map(dragged.from, 1);
  view.dispatch(put);

  // The put-down and the repairs appended to it insert, wrap and lift, which
  // keep a node standing whole as the same node: the original is the row node
  // itself, wherever it stands now. Failing that, the row where it maps to
  // through the put-down's own steps, when it carries the row's id.
  const { doc } = view.state;
  let at = positionOf(doc, dragged.node);
  if (at < 0 && doc.nodeAt(mapped)?.attrs['id'] === draggedId) at = mapped;
  if (at < 0) return true;
  const original = doc.nodeAt(at)!;
  // A row that is the only child of its nested group, or of its column,
  // leaves with it.
  const leaving = rangeToLift(doc, { node: original, from: at, to: at + original.nodeSize });
  view.dispatch(view.state.tr.delete(leaving.from, leaving.to));
  return true;
}

/**
 * The weights of the group a drop lands in, the new column's last: a new
 * group, or one a merge left with one column, is two even columns; otherwise
 * the new column takes the mean of the columns that stay, and a lone block
 * moving within its group takes its column along.
 * @param from - The dragged row's column, if it stands in one.
 * @param to - The target's column, if it stands in one.
 * @returns The weights.
 */
export function weightsAfterDrop(from: InColumn | null, to: InColumn | null): number[] {
  const same = from !== null && to !== null && from.groupPos === to.groupPos;
  if (to === null || (to.group.childCount === 1 && !same)) return [1, 1];
  const leaving = same && from.column.childCount === 1 ? from.index : -1;
  const kept = weightsOf(to.group).filter((_weight, index) => index !== leaving);
  return [...kept, meanWeight(kept)];
}
