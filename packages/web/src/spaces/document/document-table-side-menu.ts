// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which block the side menu stands for at a table's height (inner#1619
 * design 5.3, "格子里块的手柄、表格手柄").
 *
 * With the pointer on a block in a cell, the menu is that block's. Anywhere
 * else at the table's height — the gutter left of it, the room right of it —
 * the menu is the table's: its icon, its menu, its drag. BlockNote 0.56 goes
 * down from wherever it lands to the deepest block at the pointer's height
 * (`sideMenuHover.ts` `probeBlockAtHeight`, `blockGeometry.ts`
 * `getNestedBlockAtCursor`), so from the gutter it reaches a block in the
 * first cell of that row and the table's handle is out of reach. The side
 * menu's state is read and, when it names a block in a cell the pointer is
 * not in, set to the table instead.
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
 * The table the side menu stands for instead of the block it names, when the
 * pointer is not in that block's cell.
 * @param body - The editable element.
 * @param blockId - The block the side menu names.
 * @param pointer - Where the pointer is.
 * @returns The table's id, or undefined to leave the menu as it is.
 */
export function tableInsteadOf(body: HTMLElement, blockId: string, pointer: Point): string | undefined {
  const block = body.querySelector(`[data-id="${CSS.escape(blockId)}"]:not([data-node-type="blockOuter"])`);
  const cell = block?.closest('td, th');
  const table = cell?.closest(`[data-node-type="${DOC_TABLE}"]`);
  if (cell === null || cell === undefined || table === null || table === undefined) return undefined;
  const box = cell.getBoundingClientRect();
  const inCell = pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
  return inCell ? undefined : (table.getAttribute('data-id') ?? undefined);
}

/**
 * The extension that hands the side menu to the table outside its cells.
 * @returns The extension, for the assembly to register.
 */
export const documentTableSideMenuExtension = createExtension(({ editor }) => ({
  key: 'documentTableSideMenu',
  mount({ signal }: { signal: AbortSignal }): void {
    const ours = editor as unknown as BlockNoteEditor<never, never, never>;
    const sideMenu = ours.getExtension(SideMenuExtension);
    if (sideMenu === undefined) return;
    let pointer: Point | undefined;
    // On the window in the capture phase, ahead of the side menu's own
    // listener on the document, so the point is current when its state moves.
    window.addEventListener(
      'mousemove',
      (event) => {
        pointer = { x: event.clientX, y: event.clientY };
      },
      { signal, capture: true },
    );
    const unsubscribe = sideMenu.store.subscribe(() => {
      const state = sideMenu.store.state;
      if (state?.show !== true || pointer === undefined) return;
      // The menu hides as the editor unmounts, when its view is gone.
      const body = domElementOf(ours);
      if (body === null) return;
      const tableId = tableInsteadOf(body, state.block.id, pointer);
      const table = tableId === undefined ? undefined : editor.getBlock(tableId);
      if (table === undefined) return;
      sideMenu.store.setState({ ...state, block: table as never });
    });
    signal.addEventListener('abort', () => unsubscribe());
  },
}));
