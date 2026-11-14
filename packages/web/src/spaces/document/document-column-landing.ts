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
import { columnWeight, DOC_COLUMN, MAX_COLUMNS, meanWeight, weightsFit } from '@web/spaces/document/document-column-geometry';
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
  const kept: number[] = [];
  to?.group.forEach((column, _offset, index) => {
    if (index !== leaving) kept.push(columnWeight(column.attrs['width']));
  });
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
  // The node the pointer is inside starts at `inside` (a table level with the
  // pointer, outside its cells), then come the nodes around it.
  for (let depth = at.inside >= 0 ? $at.depth + 1 : $at.depth; depth > 0; depth -= 1) {
    const node = depth > $at.depth ? $at.nodeAfter : $at.node(depth);
    if (node === null || (node.type.name !== 'blockContainer' && node.type.name !== DOC_TABLE)) continue;
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
    const row = rowAt(view, event.clientX, event.clientY);
    // A drag beside the body reaches here re-sent and held to the body's box
    // (BlockNote `SideMenu/blockDropHandling.ts`): held to its left edge, the
    // pointer is out in the gutter; held to its top or bottom edge, it is
    // above or below the body, level with no row.
    const group = view.dom.firstElementChild?.getBoundingClientRect();
    const held =
      (event as { synthetic?: boolean }).synthetic === true &&
      (event.clientX <= (row?.holderLeft ?? 0) || (group !== undefined && (event.clientY <= group.top || event.clientY >= group.bottom)));
    const side = row === null || held ? null : sideOfPointer(event.clientX, row.box, row.holderLeft);
    if (row === null || side === null) return next(context);
    const room = { bodyWidth: view.dom.clientWidth };
    if (!sideDropAllowed(view.state.doc, draggedId, row.id, side, room)) return next(context);
    shown = { draggedId, targetId: row.id, side };
    return { pos: row.pos, orientation: side === 'left' ? 'block-vertical-left' : 'block-vertical-right' };
  };
}
