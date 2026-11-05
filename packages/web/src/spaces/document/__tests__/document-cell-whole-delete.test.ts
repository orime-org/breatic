// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Taking away a selection that covers every block of one table cell keeps the
 * cell with one empty paragraph in it (inner#1351 design §5.4.6 "cell
 * structure"; inner#1619 T6): the row keeps its cells and every other cell
 * keeps its column, whether the words leave by a drag, a cut or a delete key.
 */

import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';

import { open, positionOf, settled } from './paste-harness';
import { tableBlock } from './table-fixtures';

type Editor = ReturnType<typeof open>['editor'];

/**
 * A body with a two-row table whose first cell holds a heading and a paragraph,
 * those two selected whole.
 * @returns The editor.
 */
async function wholeCellSelected(): Promise<Editor> {
  const table = tableBlock({
    rows: [
      { cells: [{ blocks: [{ type: 'heading', content: 'Head' }, { type: 'paragraph', content: 'line' }] }, 'c2'] },
      { cells: ['d1', 'd2'] },
    ],
  });
  const { editor } = open([{ type: 'paragraph', content: 'lead' }, table, { type: 'paragraph', content: 'tail' }] as never);
  await act(async () => { await settled(); });
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'Head', 0), positionOf(editor, 'line', 4))));
  view.focus();
  return editor;
}

/**
 * Each row's cells, by their words.
 * @param editor - The editor.
 * @returns Per row, each cell's words.
 */
function rows(editor: Editor): string[][] {
  const out: string[][] = [];
  editor.prosemirrorView.state.doc.descendants((node) => {
    if (node.type.name !== 'docTableRow') return true;
    const cells: string[] = [];
    node.forEach((cell) => cells.push(cell.textContent));
    out.push(cells);
    return false;
  });
  return out;
}

/**
 * Asserts the first cell is left with one empty paragraph and the caret in it.
 * @param editor - The editor.
 */
function expectEmptiedCell(editor: Editor): void {
  expect(rows(editor)).toEqual([['', 'c2'], ['d1', 'd2']]);
  const { $head } = editor.prosemirrorView.state.selection;
  expect($head.parent.type.name).toBe('paragraph');
  expect($head.parent.content.size).toBe(0);
  let cell = '';
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if ($head.node(depth).type.name === 'docTableCell') cell = $head.node(depth).textContent;
  }
  expect(cell).toBe('');
}

/**
 * Presses a key the way the browser hands it to the editor.
 * @param editor - The editor.
 * @param key - The key.
 */
function press(editor: Editor, key: string): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handle) => handle(view, event));
}

describe('a selection covering one whole cell, taken away', () => {
  it.each(['Backspace', 'Delete'])('by %s keeps the cell with one empty paragraph, and undo puts the words back', async (key) => {
    const editor = await wholeCellSelected();
    const before = editor.prosemirrorView.state.doc.toJSON();

    press(editor, key);

    expectEmptiedCell(editor);
    editor.undo();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before);
  });

  it('by a cut keeps the cell with one empty paragraph, after copying the words', async () => {
    const editor = await wholeCellSelected();
    const data: Record<string, string> = {};
    const event = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (format: string, value: string) => { data[format] = value; },
        clearData: () => undefined,
        getData: (format: string) => data[format] ?? '',
      },
    });

    editor.prosemirrorView.dom.dispatchEvent(event);

    expect(data['text/plain']).toContain('Head');
    expectEmptiedCell(editor);
  });

  it('by a drag moved into the body keeps the cell with one empty paragraph, the words landing at the drop', async () => {
    const editor = await wholeCellSelected();
    const view = editor.prosemirrorView;
    view.dom.parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.serializeForClipboard(view.state.selection.content()).slice, move: true };
    const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
    for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
    const at = positionOf(editor, 'tail', 4);
    view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, { clientX: 1, clientY: 1 });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['text/html'], files: [], items: [], getData: (): string => '' } });

    view.dom.dispatchEvent(drop);
    await settled();

    expect(rows(editor)).toEqual([['', 'c2'], ['d1', 'd2']]);
    expect(view.state.doc.textContent).toContain('Head');
    expect(view.state.doc.textContent).toContain('line');
  });
});
