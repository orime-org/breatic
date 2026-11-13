// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a side drop is, and when there is none (inner#1314 design §5.2).
 */

import type { ComputeDropPositionContext } from '@blocknote/core/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

import type { ColumnSide } from '@web/spaces/document/document-column-drop';
import {
  COLUMN_GAP,
  DOC_COLUMN,
  DOC_COLUMN_LIST,
  MAX_COLUMNS,
  MIN_COLUMN_WIDTH,
} from '@web/spaces/document/document-column-nodes';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { cellDepthOf, DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** A target's visible horizontal extent. */
export interface VisibleBox {
  readonly left: number;
  readonly right: number;
}

/** The room a new column has. */
export interface ColumnRoom {
  /** The body's content width, for groups in the body. */
  readonly bodyWidth: number;
}

/** How far in from a visible edge the side zone reaches. */
const SIDE_ZONE = 24;

/** Table nodes: ours, and the stored (legacy) one. */
const TABLES = new Set([DOC_TABLE, 'table']);

/**
 * The side of the target the pointer is on: within the zone of the visible
 * left edge or further left, within the zone of the visible right edge or
 * further right; the zone is at most a quarter of the visible width.
 * @param x - The pointer's x.
 * @param box - The target's visible box.
 * @returns The side, or null.
 */
export function sideOfPointer(x: number, box: VisibleBox): ColumnSide | null {
  const zone = Math.min(SIDE_ZONE, (box.right - box.left) / 4);
  if (x <= box.left + zone) return 'left';
  if (x >= box.right - zone) return 'right';
  return null;
}

/**
 * Whether a node, or any node inside it, is of one of these types.
 * @param node - The node.
 * @param types - The type names.
 * @returns True when one is found.
 */
function holds(node: PMNode, types: ReadonlySet<string>): boolean {
  if (types.has(node.type.name)) return true;
  let found = false;
  node.descendants((child) => {
    if (types.has(child.type.name)) found = true;
    return !found;
  });
  return found;
}

/**
 * Whether a node is a table holding a column group.
 * @param node - The node.
 * @returns True when it is.
 */
function tableWithColumns(node: PMNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (TABLES.has(child.type.name) && holds(child, new Set([DOC_COLUMN_LIST]))) found = true;
    return !found;
  });
  return found || (TABLES.has(node.type.name) && holds(node, new Set([DOC_COLUMN_LIST])));
}

/**
 * Whether a side drop may land there.
 * @param doc - The document.
 * @param draggedId - The dragged row's id.
 * @param targetId - The target row's id.
 * @param side - The side.
 * @param room - The room a new column has.
 * @returns True when it may.
 */
export function sideDropAllowed(
  doc: PMNode,
  draggedId: string,
  targetId: string,
  side: ColumnSide,
  room: ColumnRoom,
): boolean {
  if (draggedId === targetId) return false;
  const dragged = rowById(doc, draggedId);
  const target = rowById(doc, targetId);
  if (dragged === undefined || target === undefined) return false;
  if (target.from >= dragged.from && target.to <= dragged.to) return false;
  const $target = doc.resolve(target.from);
  // A nested child: its group hangs under a row.
  if ($target.parent.type.name === 'blockGroup' && $target.depth > 1) return false;
  // The target's cell stands in a column.
  const cell = cellDepthOf($target);
  for (let depth = cell - 1; cell > 0 && depth > 0; depth -= 1) {
    if ($target.node(depth).type.name === DOC_COLUMN) return false;
  }
  // A cell takes no table, and a column takes no table holding columns.
  if (cell > 0 && TABLES.has(dragged.node.type.name)) return false;
  if (cell > 0 && holds(dragged.node, TABLES)) return false;
  if (tableWithColumns(dragged.node) || tableWithColumns(target.node)) return false;
  const $dragged = doc.resolve(dragged.from);
  const into = $target.parent.type.name === DOC_COLUMN ? $target.node($target.depth - 1) : null;
  const fromSameGroup =
    into !== null && $dragged.parent.type.name === DOC_COLUMN && $dragged.before($dragged.depth - 1) === $target.before($target.depth - 1);
  if (fromSameGroup && $dragged.parent.childCount === 1) {
    const from = $dragged.index($dragged.depth - 1);
    const to = $target.index($target.depth - 1);
    if (side === 'left' ? to === from + 1 : to === from - 1) return false;
  }
  const columns = into === null ? 2 : into.childCount + (fromSameGroup && $dragged.parent.childCount === 1 ? 0 : 1);
  if (columns > MAX_COLUMNS) return false;
  if (cell < 0) {
    const width = (room.bodyWidth - (columns - 1) * COLUMN_GAP) / columns;
    if (width < MIN_COLUMN_WIDTH) return false;
  }
  return true;
}

/**
 * Whether "Columns" in the insert menu is out of reach on a row: in a column
 * (or in a cell of a table standing in one), in a list's nested group, or on
 * a row with children (design §5.3).
 * @param doc - The document.
 * @param blockId - The pressed row's id.
 * @returns True when the entry is greyed.
 */
export function columnsOutOfReach(doc: PMNode, blockId: string): boolean {
  const row = rowById(doc, blockId);
  if (row === undefined) return true;
  if (row.node.type.name === 'blockContainer' && row.node.childCount > 1) return true;
  const $row = doc.resolve(row.from);
  if ($row.parent.type.name === 'blockGroup' && $row.depth > 1) return true;
  for (let depth = $row.depth; depth > 0; depth -= 1) {
    if ($row.node(depth).type.name === DOC_COLUMN) return true;
  }
  return false;
}

/** A drop position hook of the drop cursor. */
type DropPositionHook = (context: ComputeDropPositionContext) => ComputeDropPositionContext['defaultPosition'];

/** The side drop the line last showed. */
interface SideDrop {
  readonly draggedId: string;
  readonly targetId: string;
  readonly side: ColumnSide;
}

let shown: SideDrop | undefined;

/**
 * Takes the side drop the line showed for this drag, if it showed one.
 * @param draggedId - The row the drag carries.
 * @returns The side drop, or undefined.
 */
export function takeSideDrop(draggedId: string): SideDrop | undefined {
  const drop = shown;
  shown = undefined;
  return drop?.draggedId === draggedId ? drop : undefined;
}

/** A row under the pointer. */
interface RowAt {
  /** Where the row starts. */
  readonly pos: number;
  /** Its id. */
  readonly id: string;
  /** Its visible horizontal extent. */
  readonly box: VisibleBox;
}

/**
 * The row level with the pointer, the gutter and margin included, and what
 * of it the user sees: a picture, video or audio by its media box, any other
 * row by its own content.
 * @param view - The editor view.
 * @param x - The pointer's x.
 * @param y - The pointer's y.
 * @returns The row, or null.
 */
function rowAt(view: EditorView, x: number, y: number): RowAt | null {
  const surface = view.dom.getBoundingClientRect();
  const at = view.posAtCoords({ left: Math.min(Math.max(x, surface.left + 1), surface.right - 1), top: y });
  if (at === null) return null;
  const $at = view.state.doc.resolve(at.inside >= 0 ? at.inside : at.pos);
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    const node = $at.node(depth);
    if (node.type.name !== 'blockContainer' && node.type.name !== DOC_TABLE) continue;
    const pos = $at.before(depth);
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    const own = dom.querySelector(':scope > .bn-block-content') ?? dom;
    const media = own.querySelector('[data-media-box]');
    const rect = (media ?? own).getBoundingClientRect();
    return { pos, id: String(node.attrs['id']), box: { left: rect.left, right: rect.right } };
  }
  return null;
}

/**
 * The drop cursor hook for row drags beside a row: a vertical line on the
 * side the pointer is on, where a side drop may land; any other drag is the
 * next hook's.
 * @param next - The hook for every other drop.
 * @param flyingRowId - The row a drag in flight carries, if any.
 * @returns The hook.
 */
export function columnDropHook(next: DropPositionHook, flyingRowId: () => string | undefined): DropPositionHook {
  return (context) => {
    shown = undefined;
    const draggedId = flyingRowId();
    if (draggedId === undefined) return next(context);
    const { view, event } = context;
    const row = rowAt(view, event.clientX, event.clientY);
    const side = row === null ? null : sideOfPointer(event.clientX, row.box);
    if (row === null || side === null) return next(context);
    const room = { bodyWidth: view.dom.clientWidth };
    if (!sideDropAllowed(view.state.doc, draggedId, row.id, side, room)) return next(context);
    shown = { draggedId, targetId: row.id, side };
    return { pos: row.pos, orientation: side === 'left' ? 'block-vertical-left' : 'block-vertical-right' };
  };
}
