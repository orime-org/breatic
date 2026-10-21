// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 design 5.3: with the pointer on a block in a cell the side menu
 * is that block's; at the table's height outside its cells it is the table's.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SideMenuExtension } from '@blocknote/core/extensions';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/** The first cell's box, where the cases put it. */
const CELL = new DOMRect(100, 100, 120, 40);

/**
 * A mounted editor holding a paragraph and a table, its first cell boxed at
 * {@link CELL}.
 * @returns The editor, and the ids of the table and the first cell's block.
 */
function open(): { editor: Editor; tableId: string; cellBlockId: string; nextBlockId: string } {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
    tableBlock({ rows: [{ cells: ['a1', 'b1'] }] }),
  ] as never);
  const table = editor.document[1] as unknown as { id: string; children: { children: { children: { id: string }[] }[] }[] };
  const cellBlockId = table.children[0]!.children[0]!.children[0]!.id;
  const nextBlockId = table.children[0]!.children[1]!.children[0]!.id;
  const td = editor.prosemirrorView.dom.querySelector('td')!;
  td.getBoundingClientRect = () => CELL;
  editor.prosemirrorView.dom.querySelector('tbody')!.getBoundingClientRect = () => new DOMRect(100, 100, 240, 40);
  return { editor, tableId: table.id, cellBlockId, nextBlockId };
}

/**
 * Moves the pointer, then has the side menu name a block, as its own
 * listener does on that move.
 * @param editor - The editor.
 * @param x - Where the pointer goes.
 * @param y - Where the pointer goes.
 * @param blockId - The block the side menu names.
 * @returns The block the side menu ends up standing for.
 */
function hover(editor: Editor, x: number, y: number, blockId: string): string | undefined {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
  const sideMenu = editor.getExtension(SideMenuExtension)!;
  sideMenu.store.setState({ show: true, referencePos: new DOMRect(), block: editor.getBlock(blockId) as never });
  return sideMenu.store.state?.block.id;
}

describe('the side menu at a table', () => {
  it('stands for the block in the cell the pointer is in', () => {
    const { editor, cellBlockId } = open();

    expect(hover(editor, 150, 120, cellBlockId)).toBe(cellBlockId);
  });

  it('stands for the first-column block at the pointer\'s height in the gutter within 40px of the table (user 2026-10-21)', () => {
    const { editor, cellBlockId, tableId } = open();

    expect(hover(editor, 62, 120, tableId)).toBe(cellBlockId);
    expect(hover(editor, 80, 120, cellBlockId)).toBe(cellBlockId);
  });

  it('stands for the table further out in the gutter', () => {
    const { editor, tableId, cellBlockId } = open();

    expect(hover(editor, 50, 120, cellBlockId)).toBe(tableId);
  });

  it('stands for the table when the pointer is right of the table', () => {
    const { editor, tableId, cellBlockId } = open();

    expect(hover(editor, 400, 120, cellBlockId)).toBe(tableId);
  });

  it('leaves the menu on its block while the pointer is on the menu itself, wherever that is drawn', () => {
    const { editor, cellBlockId } = open();
    const strip = document.createElement('div');
    strip.setAttribute('data-row-id', cellBlockId);
    document.body.appendChild(strip);
    // Over the gutter, where the table would otherwise take the menu.
    strip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 120 }));
    const sideMenu = editor.getExtension(SideMenuExtension)!;

    sideMenu.store.setState({ show: true, referencePos: new DOMRect(), block: editor.getBlock(cellBlockId) as never });

    expect(sideMenu.store.state?.block.id).toBe(cellBlockId);
  });

  it('keeps the block it was on while the pointer rests on the menu, when a change elsewhere names another', () => {
    const { editor, cellBlockId, nextBlockId } = open();
    const sideMenu = editor.getExtension(SideMenuExtension)!;
    sideMenu.store.setState({ show: true, referencePos: new DOMRect(), block: editor.getBlock(cellBlockId) as never });
    const strip = document.createElement('div');
    strip.setAttribute('data-row-id', cellBlockId);
    document.body.appendChild(strip);
    strip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 120 }));

    // The library's refresh after a remote edit reads the point beside the
    // menu, which lies in the next cell.
    sideMenu.store.setState({ show: true, referencePos: new DOMRect(), block: editor.getBlock(nextBlockId) as never });

    expect(sideMenu.store.state?.block.id).toBe(cellBlockId);
  });

  it('leaves a block outside any table as it is', () => {
    const { editor } = open();
    const above = (editor.document[0] as unknown as { id: string }).id;

    expect(hover(editor, 80, 20, above)).toBe(above);
  });
});

describe('the side menu in a cell', () => {
  it('stands for the block in the cell when the pointer is in the cell but on no block, as in its padding', () => {
    const { editor, tableId, cellBlockId } = open();
    const line = editor.prosemirrorView.dom.querySelector(`[data-node-type="blockContainer"][data-id="${cellBlockId}"]`)!;
    line.getBoundingClientRect = () => new DOMRect(140, 106, 60, 22);

    expect(hover(editor, 210, 135, tableId)).toBe(cellBlockId);
  });

  it('leaves the table when the pointer is in no cell, out past the first column\'s strips', () => {
    const { editor, tableId } = open();

    expect(hover(editor, 50, 120, tableId)).toBe(tableId);
  });
});
