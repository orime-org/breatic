// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The local repair that keeps column groups meaningful (inner#1314 design
 * §5.2), run once for every local transaction, whichever command made it.
 *
 * - A column whose blocks this transaction took away entirely, so that it now
 *   holds only the empty paragraph ProseMirror filled in for its `+`, is
 *   deleted. The test compares the column with the document before the
 *   transaction: a column that did not exist then (a group just inserted),
 *   or whose new block holds words (a block replaced in place), stays.
 * - A group left with one column, which this transaction touched, dissolves
 *   into that column's blocks; a group left with no column is deleted.
 * - The take-away half of a two-step move ({@link COLUMN_TAKE_AWAY}) only
 *   deletes the emptied column: the put-down half may land in the same
 *   group, and dissolving in between would rebuild the column left standing.
 *
 * Remote transactions are left alone: a repair appended to a collaborator's
 * change is not written back to Yjs (see `document-table-nodes.tsx` on
 * y-prosemirror), and the repair belongs to whoever made the change.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from 'y-prosemirror';

import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-nodes';

/**
 * Meta on the take-away half of a two-step move: the emptied column is
 * deleted, and the group is not dissolved until the put-down half has run.
 */
export const COLUMN_TAKE_AWAY = new PluginKey('doc-column-take-away');

/** A range of the document after the transactions. */
type Range = readonly [number, number];

/**
 * Whether a transaction came from a collaborator, or from undo and redo,
 * which y-prosemirror replays from Yjs.
 * @param tr - The transaction.
 * @returns True when the binding made it.
 */
function isRemote(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}

/**
 * The ids of every node carrying one, in a document.
 * @param doc - The document.
 * @returns The ids.
 */
function idsOf(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string') ids.add(id);
    return true;
  });
  return ids;
}

/**
 * Whether a column holds nothing but a paragraph the transaction filled in.
 * @param column - The column.
 * @param before - The ids that existed before the transaction.
 * @returns True when its blocks were all taken away.
 */
function emptiedColumn(column: PMNode, before: ReadonlySet<string>): boolean {
  const columnId = column.attrs['id'];
  if (typeof columnId !== 'string' || !before.has(columnId)) return false;
  if (column.childCount !== 1) return false;
  const row = column.firstChild!;
  if (row.type.name !== 'blockContainer' || row.childCount !== 1) return false;
  const content = row.firstChild!;
  if (content.type.name !== 'paragraph' || content.content.size > 0) return false;
  const rowId = row.attrs['id'];
  return typeof rowId !== 'string' || !before.has(rowId);
}

/**
 * The ranges the local steps of these transactions changed, in the document
 * after all of them.
 * @param transactions - The transactions, in order.
 * @returns The ranges.
 */
function localRanges(transactions: readonly Transaction[]): Range[] {
  const maps = transactions.flatMap((tr) => tr.mapping.maps);
  const local = transactions.flatMap((tr) => tr.mapping.maps.map(() => !isRemote(tr)));
  const mapping = new Mapping(maps);
  const ranges: Range[] = [];
  maps.forEach((map, index) => {
    if (!local[index]) return;
    const rest = mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  });
  return ranges;
}

/**
 * Whether a range meets a node's span.
 * @param ranges - The ranges.
 * @param from - The node's start.
 * @param to - The node's end.
 * @returns True when any range reaches into it.
 */
function meets(ranges: readonly Range[], from: number, to: number): boolean {
  return ranges.some(([start, end]) => start <= to && end >= from);
}

/**
 * The repair, as a transaction on the state the transactions left.
 * @param transactions - The transactions just applied.
 * @param oldState - The state before them.
 * @param newState - The state after them.
 * @returns The repair, or null when nothing needs it.
 */
function repair(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged && !isRemote(tr))) return null;
  const takeAway = transactions.some((tr) => tr.getMeta(COLUMN_TAKE_AWAY) === true);
  const before = idsOf(oldState.doc);
  const tr = newState.tr;
  const emptied: Range[] = [];
  newState.doc.descendants((node, pos) => {
    if (node.type.name !== DOC_COLUMN) return true;
    if (emptiedColumn(node, before)) emptied.push([pos, pos + node.nodeSize]);
    return false;
  });
  for (const [from, to] of [...emptied].reverse()) tr.delete(from, to);
  if (!takeAway) {
    const touched = [
      ...localRanges(transactions).map(([from, to]): Range => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)]),
      ...emptied.map(([from]): Range => [tr.mapping.map(from, -1), tr.mapping.map(from, 1)]),
    ];
    const groups: { pos: number; node: PMNode }[] = [];
    tr.doc.descendants((node, pos) => {
      if (node.type.name !== DOC_COLUMN_LIST) return true;
      if (node.childCount === 0 || (node.childCount === 1 && meets(touched, pos, pos + node.nodeSize))) {
        groups.push({ pos, node });
      }
      return false;
    });
    for (const { pos, node } of groups.reverse()) {
      if (node.childCount === 0) tr.delete(pos, pos + node.nodeSize);
      else tr.replaceWith(pos, pos + node.nodeSize, node.firstChild!.content);
    }
  }
  return tr.docChanged ? tr : null;
}

/**
 * The plugin that repairs column groups after every local transaction.
 * @returns The plugin.
 */
export function columnRepairPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('doc-column-repair'),
    appendTransaction: (transactions, oldState, newState) => repair(transactions, oldState, newState),
  });
}

/**
 * The extension that carries the column repair.
 * @returns The extension, for the assembly to register.
 */
export const documentColumnRepairExtension = createExtension(() => ({
  key: 'document-column-repair',
  prosemirrorPlugins: [columnRepairPlugin()],
}));
