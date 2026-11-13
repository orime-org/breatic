// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which block the side menu stands for at a table's height (inner#1619
 * design 5.3, "Block handles inside cells and the table handle").
 *
 * A cell is a small body: with the pointer anywhere in a cell, the menu is the
 * block in that cell at the pointer's height, or the nearest one. In the
 * gutter within `TABLE_STRIP_OUTSET` of the table's left line, where the
 * strips of the first column's blocks stand, it is the first-column block at
 * the pointer's height. Anywhere else at the table's height — further out in
 * the gutter, the room right of the table — the menu names the table and
 * draws nothing: the table's own strip shows whenever the table is hovered
 * (`DocumentTableHandlesController`, user 2026-10-21). BlockNote 0.56 goes down from wherever it lands
 * to the deepest block at the pointer's height (`sideMenuHover.ts`
 * `probeBlockAtHeight`, `blockGeometry.ts` `getNestedBlockAtCursor`), so from
 * the gutter it reaches a block in the first cell of that row, and from a
 * cell's padding, where no block is at the pointer, it climbs to the table.
 * The side menu's state is read and set to the block this rule gives when it
 * names another.
 *
 * With the pointer on the menu, the menu keeps the block it stands for, as
 * BlockNote keeps it (`SideMenu.ts:169-178`), also through the refresh a
 * document change runs (`SideMenu.ts:381-385`), which reads the point just
 * right of the menu (`SideMenu.ts:251-274`): beside a strip drawn over the
 * cell to its block's left, that point is in the other cell.
 */

import { createExtension, type BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';

import { domElementOf } from '@web/spaces/document/document-editor-view';
import { TABLE_STRIP_OUTSET, tableLineOf } from '@web/spaces/document/document-strip-alignment';
import { COLUMN_GAP } from '@web/spaces/document/document-column-nodes';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** A point in viewport coordinates. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Whether a point is inside a box.
 * @param box - The box.
 * @param at - The point.
 * @returns True when it is.
 */
function contains(box: DOMRect, at: Point): boolean {
  return at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;
}

/**
 * The block in a cell at a height: the deepest one whose box reaches it, or
 * else the nearest.
 * @param cell - The cell.
 * @param y - The height.
 * @returns The block's id, or undefined when the cell holds none.
 */
function blockInCellAt(cell: Element, y: number): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const block of cell.querySelectorAll('[data-node-type="blockContainer"][data-id]')) {
    const box = block.getBoundingClientRect();
    const distance = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    // Later in document order is deeper, so it wins a tie.
    if (best === undefined || distance <= best.distance) {
      best = { id: block.getAttribute('data-id') ?? '', distance };
    }
  }
  return best?.id || undefined;
}

/**
 * The block of the table's first column at the pointer's height, when the
 * pointer is in the gutter where the first column's strips stand.
 * @param table - The table's element.
 * @param pointer - Where the pointer is.
 * @returns The block's id, or undefined elsewhere.
 */
function firstColumnBlockAt(table: Element, pointer: Point): string | undefined {
  const line = tableLineOf(table);
  if (line === undefined || pointer.x >= line || pointer.x < line - TABLE_STRIP_OUTSET) return undefined;
  const beside = { x: line + 1, y: pointer.y };
  const cell = [...table.querySelectorAll('td, th')].find((c) => contains(c.getBoundingClientRect(), beside));
  return cell === undefined ? undefined : blockInCellAt(cell, pointer.y);
}

/**
 * The block a column holds at a height, the deepest one whose box reaches it
 * or else the nearest; a table in the column stands for itself, its cells'
 * blocks are the table's.
 * @param column - The column.
 * @param y - The height.
 * @returns The block's id, or undefined.
 */
function blockInColumnAt(column: Element, y: number): string | undefined {
  let best: { id: string; distance: number } | undefined;
  const rows = column.querySelectorAll(`[data-node-type="blockContainer"][data-id], [data-node-type="${DOC_TABLE}"][data-id]`);
  for (const row of rows) {
    const inCell = row.closest('td, th');
    if (row.closest('.doc-column') !== column || (inCell !== null && column.contains(inCell))) continue;
    const box = row.getBoundingClientRect();
    const distance = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (best === undefined || distance <= best.distance) best = { id: row.getAttribute('data-id') ?? '', distance };
  }
  return best?.id || undefined;
}

/**
 * The block of a column group at the pointer: each column takes the gap's
 * half next to it, the first column the gutter left of the group and the
 * last the room right of it (inner#1314 design §5.2).
 * @param block - The element of the block the side menu names.
 * @param pointer - Where the pointer is.
 * @returns The block's id, or undefined when no group is in question.
 */
function columnBlockAt(block: Element, pointer: Point): string | undefined {
  const group = block.matches('.doc-columns') ? block : block.closest('.doc-columns');
  if (group === null || group.hasAttribute('data-stacked')) return undefined;
  const cell = block.closest('td, th');
  if (cell !== null && group.contains(cell)) return undefined;
  const columns = [...group.querySelectorAll(':scope > .doc-column')];
  const column = columns.find((candidate, index) => {
    const box = candidate.getBoundingClientRect();
    const from = index === 0 ? -Infinity : box.left - COLUMN_GAP / 2;
    const to = index === columns.length - 1 ? Infinity : box.right + COLUMN_GAP / 2;
    return pointer.x >= from && pointer.x < to;
  });
  return column === undefined ? undefined : blockInColumnAt(column, pointer.y);
}

/**
 * The block the side menu stands for instead of the one it names.
 * @param body - The editable element.
 * @param blockId - The block the side menu names.
 * @param pointer - Where the pointer is.
 * @returns The block's id, or undefined to leave the menu as it is.
 */
export function blockForPointer(body: HTMLElement, blockId: string, pointer: Point): string | undefined {
  const block = body.querySelector(`[data-id="${CSS.escape(blockId)}"]:not([data-node-type="blockOuter"])`);
  if (block === null) return undefined;
  const inColumn = columnBlockAt(block, pointer);
  if (inColumn !== undefined) return inColumn === blockId ? undefined : inColumn;
  const isTable = block.matches(`[data-node-type="${DOC_TABLE}"]`);
  const table = isTable ? block : block.closest('td, th')?.closest(`[data-node-type="${DOC_TABLE}"]`);
  if (table === null || table === undefined) return undefined;
  // Left of the table's drawn line the gutter is the first column's and the
  // table's: a cell scrolled out behind the frame keeps its box there.
  const line = tableLineOf(table);
  const cell =
    line !== undefined && pointer.x < line
      ? undefined
      : [...table.querySelectorAll('td, th')].find((c) => contains(c.getBoundingClientRect(), pointer));
  // In its own cell, a block is BlockNote's own reading of the pointer.
  if (!isTable && cell?.contains(block) === true) return undefined;
  const id =
    (cell === undefined ? undefined : blockInCellAt(cell, pointer.y)) ??
    firstColumnBlockAt(table, pointer) ??
    (isTable ? undefined : (table.getAttribute('data-id') ?? undefined));
  return id === blockId ? undefined : id;
}

/**
 * The extension that hands the side menu to a cell's block inside the cell
 * and to the table outside its cells.
 * @returns The extension, for the assembly to register.
 */
export const documentTableSideMenuExtension = createExtension(({ editor }) => ({
  key: 'documentTableSideMenu',
  mount({ signal }: { signal: AbortSignal }): void {
    const ours = editor as unknown as BlockNoteEditor<never, never, never>;
    const sideMenu = ours.getExtension(SideMenuExtension);
    if (sideMenu === undefined) return;
    let pointer: Point | undefined;
    // The block the menu stood for when the pointer came onto the menu, held
    // while it stays there: a block's handle in a cell is drawn over the cell
    // to its left (inner#1619 T13), and its drag starts from there.
    let pinned: string | undefined;
    // On the window in the capture phase, ahead of the side menu's own
    // listener on the document, so the point is current when its state moves.
    /** Hands the menu to the block the pointer stands for, if that is another. */
    const follow = (): void => {
      const state = sideMenu.store.state;
      if (state?.show !== true || pointer === undefined) return;
      // The menu hides as the editor unmounts, when its view is gone.
      const body = domElementOf(ours);
      if (body === null) return;
      const id = pinned === undefined ? blockForPointer(body, state.block.id, pointer) : pinned === state.block.id ? undefined : pinned;
      const next = id === undefined ? undefined : editor.getBlock(id);
      if (next === undefined) return;
      sideMenu.store.setState({ ...state, block: next as never });
    };
    window.addEventListener(
      'mousemove',
      (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        const onMenu = event.target instanceof Element && event.target.closest('[data-row-id]') !== null;
        if (!onMenu) pinned = undefined;
        else if (pinned === undefined) pinned = sideMenu.store.state?.show === true ? sideMenu.store.state.block.id : undefined;
        // Across a column group's gap the side menu keeps naming the block
        // it found, so the half of the gap the pointer is on is read on
        // every move (inner#1314 design §5.2). Not while a button is held: a
        // press on a handle is a drag about to start, and handing the menu to
        // another block then swaps the pressed handle out before the browser
        // starts the drag.
        const inGroup = event.target instanceof Element && event.target.closest('.doc-columns') !== null;
        if (!onMenu && inGroup && event.buttons === 0) follow();
      },
      { signal, capture: true },
    );
    const unsubscribe = sideMenu.store.subscribe(follow);
    signal.addEventListener('abort', () => unsubscribe());
  },
}));
