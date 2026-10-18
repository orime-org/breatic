// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which block the side menu stands for at a table's height (inner#1619
 * design 5.3, "格子里块的手柄、表格手柄").
 *
 * A cell is a small body: with the pointer anywhere in a cell, the menu is the
 * block in that cell at the pointer's height, or the nearest one. Anywhere
 * else at the table's height — the gutter left of it, the room right of it —
 * the menu is the table's: its icon, its menu, its drag. BlockNote 0.56 goes
 * down from wherever it lands to the deepest block at the pointer's height
 * (`sideMenuHover.ts` `probeBlockAtHeight`, `blockGeometry.ts`
 * `getNestedBlockAtCursor`), so from the gutter it reaches a block in the
 * first cell of that row, and from a cell's padding, where no block is at the
 * pointer, it climbs to the table. The side menu's state is read and set to
 * the block this rule gives when it names another.
 */

import { createExtension, type BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';

import { domElementOf } from '@web/spaces/document/document-editor-view';
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
 * The block the side menu stands for instead of the one it names.
 * @param body - The editable element.
 * @param blockId - The block the side menu names.
 * @param pointer - Where the pointer is.
 * @returns The block's id, or undefined to leave the menu as it is.
 */
export function blockForPointer(body: HTMLElement, blockId: string, pointer: Point): string | undefined {
  const block = body.querySelector(`[data-id="${CSS.escape(blockId)}"]:not([data-node-type="blockOuter"])`);
  if (block === null) return undefined;
  if (block.matches(`[data-node-type="${DOC_TABLE}"]`)) {
    const cell = [...block.querySelectorAll('td, th')].find((c) => contains(c.getBoundingClientRect(), pointer));
    const inCell = cell === undefined ? undefined : blockInCellAt(cell, pointer.y);
    return inCell === blockId ? undefined : inCell;
  }
  const cell = block.closest('td, th');
  const table = cell?.closest(`[data-node-type="${DOC_TABLE}"]`);
  if (cell === null || cell === undefined || table === null || table === undefined) return undefined;
  return contains(cell.getBoundingClientRect(), pointer) ? undefined : (table.getAttribute('data-id') ?? undefined);
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
    // Whether the pointer is on the menu itself. A block's handle in a cell
    // is drawn over the cell to its left (inner#1619 T13): the menu stays on
    // its block there, as BlockNote keeps it (`SideMenu.ts:169-178`), and its
    // drag starts from there.
    let onMenu = false;
    // On the window in the capture phase, ahead of the side menu's own
    // listener on the document, so the point is current when its state moves.
    window.addEventListener(
      'mousemove',
      (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        onMenu = event.target instanceof Element && event.target.closest('[data-row-id]') !== null;
      },
      { signal, capture: true },
    );
    const unsubscribe = sideMenu.store.subscribe(() => {
      const state = sideMenu.store.state;
      if (state?.show !== true || pointer === undefined || onMenu) return;
      // The menu hides as the editor unmounts, when its view is gone.
      const body = domElementOf(ours);
      if (body === null) return;
      const id = blockForPointer(body, state.block.id, pointer);
      const next = id === undefined ? undefined : editor.getBlock(id);
      if (next === undefined) return;
      sideMenu.store.setState({ ...state, block: next as never });
    });
    signal.addEventListener('abort', () => unsubscribe());
  },
}));
