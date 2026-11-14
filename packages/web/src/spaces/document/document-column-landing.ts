// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a side drop is, and when there is none (inner#1314 design §5.2).
 */

import type { ComputeDropPositionContext } from '@blocknote/core/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

import { columnAround, landsInPlace, type ColumnSide } from '@web/spaces/document/document-column-drop';
import { holds, LISTS } from '@web/spaces/document/document-column-entry';
import { DOC_COLUMN, DOC_COLUMN_LIST, MAX_COLUMNS, meanWeight, weightsFit, weightsOf } from '@web/spaces/document/document-column-geometry';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { cellDepthOf, DOC_TABLE, isTableCell } from '@web/spaces/document/document-table-nodes';

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
 * The side of the target the pointer is on: from the left edge of the body,
 * cell or column holding it to within the zone of its visible left edge, or
 * within the zone of its visible right edge and anything further right; the
 * zone is at most a quarter of the visible width. Left of that holder sits
 * the block handle, and a drag straight down from it reorders.
 * @param x - The pointer's x.
 * @param box - The target's visible box.
 * @param holderLeft - The left edge of the body, cell or column holding it.
 * @returns The side, or null.
 */
export function sideOfPointer(x: number, box: VisibleBox, holderLeft: number): ColumnSide | null {
  const zone = Math.min(SIDE_ZONE, (box.right - box.left) / 4);
  if (x <= box.left + zone) return x >= holderLeft ? 'left' : null;
  if (x >= box.right - zone) return 'right';
  return null;
}

/**
 * Whether a node is a table holding a column group, or holds one.
 * @param node - The node.
 * @returns True when it is or does.
 */
function tableWithColumns(node: PMNode): boolean {
  let found = TABLES.has(node.type.name) && holds(node, LISTS);
  node.descendants((child) => {
    if (!found && TABLES.has(child.type.name)) found = holds(child, LISTS);
    return !found;
  });
  return found;
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
  const dragged = rowById(doc, draggedId);
  const target = rowById(doc, targetId);
  if (dragged === undefined || target === undefined) return false;
  // The dragged row itself, or a row inside it.
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
  if (cell > 0 && holds(dragged.node, TABLES)) return false;
  if (tableWithColumns(dragged.node) || tableWithColumns(target.node)) return false;
  if (landsInPlace(doc, dragged, target, side)) return false;
  const from = columnAround(doc.resolve(dragged.from));
  const to = columnAround($target);
  // A lone block moving within its group takes its column along.
  const leaving = from !== null && to !== null && from.groupPos === to.groupPos && from.column.childCount === 1 ? from.index : -1;
  const kept = to === null ? [] : weightsOf(to.group).filter((_weight, index) => index !== leaving);
  // The new column takes the mean, as the drop writes it; a new group is even.
  const weights = to === null ? [1, 1] : [...kept, meanWeight(kept)];
  if (weights.length > MAX_COLUMNS) return false;
  if (cell < 0 && !weightsFit(room.bodyWidth, weights)) return false;
  return true;
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
 * Forgets the side drop a line last showed: a drag that ended without a drop
 * (Escape) leaves it, and a drop with no line shown since (a table full
 * screen draws none) would take it.
 */
export function forgetSideDrop(): void {
  shown = undefined;
}

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
  /** The left edge of the body, cell or column holding it. */
  readonly holderLeft: number;
}

/**
 * The box of a group's column nearest a point across.
 * @param group - The group's element.
 * @param x - The point's x.
 * @returns The box, or null for a group with no column drawn.
 */
function nearestColumn(group: HTMLElement, x: number): DOMRect | null {
  let nearest: DOMRect | null = null;
  let distance = Infinity;
  for (const column of group.querySelectorAll(':scope > .doc-columns-row > .doc-column')) {
    const box = column.getBoundingClientRect();
    const away = Math.max(box.left - x, 0, x - box.right);
    if (away < distance) [nearest, distance] = [box, away];
  }
  return nearest;
}

/**
 * Computed lengths added up, in pixels.
 * @param lengths - The computed values.
 * @returns Their sum, a missing one counting 0.
 */
function pixelsOf(...lengths: string[]): number {
  return lengths.reduce((sum, length) => sum + (Number.parseFloat(length) || 0), 0);
}

/**
 * The room inside a cell, its padding and border taken off.
 * @param cell - The cell's element.
 * @returns Its left and right.
 */
function cellRoom(cell: HTMLElement): VisibleBox {
  const box = cell.getBoundingClientRect();
  const style = getComputedStyle(cell);
  return {
    left: box.left + pixelsOf(style.borderLeftWidth, style.paddingLeft),
    right: box.right - pixelsOf(style.borderRightWidth, style.paddingRight),
  };
}

/**
 * The row level with the pointer, the gutter and margin included, and what
 * of it the user sees: a picture, video or audio by its media box, any other
 * row by its own content. In the gap between two columns, or in a cell's
 * padding, the pointer is inside the group or the cell itself: the row is
 * the one level with it in the nearest column, or in the cell.
 * @param view - The editor view.
 * @param x - The pointer's x.
 * @param y - The pointer's y.
 * @param fromMargin - Whether the drag is out in the page margin, held to the
 *   body's box: the row there is the body's, a table whole.
 * @param hops - How many times x was already moved in.
 * @returns The row, or null.
 */
function rowAt(view: EditorView, x: number, y: number, fromMargin: boolean, hops = 0): RowAt | null {
  const surface = view.dom.getBoundingClientRect();
  const at = view.posAtCoords({ left: Math.min(Math.max(x, surface.left + 1), surface.right - 1), top: y });
  if (at === null) return null;
  const inside = at.inside >= 0 && hops < 2 ? view.state.doc.nodeAt(at.inside) : null;
  const element = inside === null ? null : view.nodeDOM(at.inside);
  if (element instanceof HTMLElement) {
    const room = inside!.type.name === DOC_COLUMN_LIST ? nearestColumn(element, x) : !fromMargin && isTableCell(inside!) ? cellRoom(element) : undefined;
    if (room === null) return null;
    if (room !== undefined) return rowAt(view, Math.min(Math.max(x, room.left + 1), room.right - 1), y, fromMargin, hops + 1);
  }
  const $at = view.state.doc.resolve(at.inside >= 0 ? at.inside : at.pos);
  // The node the pointer is inside starts at `inside` (a table level with the
  // pointer, outside its cells), then come the nodes around it; from inside
  // the body a table around the pointer is no row of its own.
  for (let depth = at.inside >= 0 ? $at.depth + 1 : $at.depth; depth > 0; depth -= 1) {
    const node = depth > $at.depth ? $at.nodeAfter : $at.node(depth);
    const table = node?.type.name === DOC_TABLE && (fromMargin || depth > $at.depth);
    if (node === null || (node.type.name !== 'blockContainer' && !table)) continue;
    const pos = depth > $at.depth ? $at.pos : $at.before(depth);
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    // A row's own content sits in its outer element's block (BlockNote
    // `BlockContainer.ts`); a table has none, and its cells' media are not its own.
    const own = dom.querySelector(':scope > .bn-block > .bn-block-content');
    const media = own?.querySelector('[data-media-box]');
    const rect = (media ?? own ?? dom).getBoundingClientRect();
    // The body's own group, a cell or a column; the editor surface itself
    // reaches out over the gutter.
    const holder = dom.parentElement?.closest('.doc-column, td, th, .bn-block-group') ?? dom;
    return {
      pos,
      id: String(node.attrs['id']),
      box: { left: rect.left, right: rect.right },
      holderLeft: holder.getBoundingClientRect().left,
    };
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
    // A drag beside the body reaches here re-sent and held to the body's box
    // (BlockNote `SideMenu/blockDropHandling.ts`): held to its left edge, the
    // pointer is out in the gutter; held to its top or bottom edge, it is
    // above or below the body, level with no row.
    const fromMargin = (event as { synthetic?: boolean }).synthetic === true;
    const row = rowAt(view, event.clientX, event.clientY, fromMargin);
    const group = view.dom.firstElementChild?.getBoundingClientRect();
    const held =
      fromMargin &&
      (event.clientX <= (row?.holderLeft ?? 0) || (group !== undefined && (event.clientY <= group.top || event.clientY >= group.bottom)));
    const side = row === null || held ? null : sideOfPointer(event.clientX, row.box, row.holderLeft);
    if (row === null || side === null) return next(context);
    const room = { bodyWidth: view.dom.clientWidth };
    if (!sideDropAllowed(view.state.doc, draggedId, row.id, side, room)) return next(context);
    shown = { draggedId, targetId: row.id, side };
    return { pos: row.pos, orientation: side === 'left' ? 'block-vertical-left' : 'block-vertical-right' };
  };
}
