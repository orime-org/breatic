// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A3 and A4: Tab and Shift-Tab move between cells, Tab in the last
 * cell adds a row, Enter breaks the line inside the cell, and a side arrow
 * over selected words in a cell collapses them there.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens a mounted editor holding a 2 × 2 table, quoted when asked.
 * @param quoted - Whether the table sits in a quote.
 * @returns The editor.
 */
function open(quoted = false): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'table',
      props: { quoted },
      content: {
        type: 'tableContent',
        rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }],
      },
    },
  ] as never);
  return editor;
}

/**
 * Puts the caret at the end of a cell's text.
 * @param editor - The editor.
 * @param text - The cell's text.
 */
function caretAfter(editor: Editor, text: string): void {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) {
      at = pos + text.length;
    }
    return at < 0;
  });
  if (at < 0) {
    throw new Error(`no cell "${text}"`);
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

/**
 * Presses a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @param shift - Whether Shift is held.
 * @returns Whether a handler claimed it.
 */
function press(editor: Editor, key: string, shift = false): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/**
 * The text of the cell holding the caret.
 * @param editor - The editor.
 * @returns That text, or null outside a cell.
 */
function caretCell(editor: Editor): string | null {
  const { $head } = editor.prosemirrorState.selection;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      return node.textContent;
    }
  }
  return null;
}

/**
 * The table node.
 * @param editor - The editor.
 * @returns It.
 */
function table(editor: Editor): PMNode {
  let found: PMNode | null = null;
  editor.prosemirrorState.doc.descendants((node) => {
    if (found === null && node.type.name === 'table') {
      found = node;
    }
    return found === null;
  });
  if (found === null) {
    throw new Error('no table');
  }
  return found;
}

describe('keys in a table cell', () => {
  it('Tab moves to the next cell and changes nothing', () => {
    const editor = open();
    caretAfter(editor, 'a1');
    const before = editor.prosemirrorState.doc;

    expect(press(editor, 'Tab')).toBe(true);

    expect(caretCell(editor)).toBe('b1');
    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('Tab at the end of a row moves to the next row', () => {
    const editor = open();
    caretAfter(editor, 'b1');
    press(editor, 'Tab');
    expect(caretCell(editor)).toBe('a2');
  });

  it('Shift-Tab moves to the previous cell, and stays in the first', () => {
    const editor = open();
    caretAfter(editor, 'b1');
    expect(press(editor, 'Tab', true)).toBe(true);
    expect(caretCell(editor)).toBe('a1');

    const before = editor.prosemirrorState.doc;
    expect(press(editor, 'Tab', true)).toBe(true);
    expect(caretCell(editor)).toBe('a1');
    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it.each([
    ['ArrowRight', 'the end', 2],
    ['ArrowLeft', 'the start', 0],
  ] as const)('%s over words selected in a cell collapses them to %s, in that cell', (key, _end, offset) => {
    // The words a Shift-Tab selects reach both edges of the cell, where the
    // table plugin's own arrow would leave for the next cell.
    const editor = open();
    caretAfter(editor, 'b1');
    press(editor, 'Tab', true);
    press(editor, 'Tab');
    expect(editor.prosemirrorState.selection.empty).toBe(false);

    expect(press(editor, key)).toBe(true);

    const { selection } = editor.prosemirrorState;
    expect(selection.empty).toBe(true);
    expect(caretCell(editor)).toBe('b1');
    expect(selection.$head.parentOffset).toBe(offset);
  });

  it('leaves Shift with an arrow to the editor', () => {
    const editor = open();
    caretAfter(editor, 'b1');
    press(editor, 'Tab', true);
    const selected = editor.prosemirrorState.selection;

    press(editor, 'ArrowLeft', true);

    expect(editor.prosemirrorState.selection.eq(selected)).toBe(true);
  });

  describe('leaving a table the body ends with', () => {
    /**
     * Stands in for the browser's answer to "is the caret on the cell's edge
     * line", which jsdom cannot give: there is no layout to measure.
     * @param editor - The editor.
     */
    function onEdgeLine(editor: Editor): void {
      editor.prosemirrorView!.endOfTextblock = (): boolean => true;
    }

    /**
     * The types of the top-level blocks.
     * @param editor - The editor.
     * @returns Them, in order.
     */
    function blockTypes(editor: Editor): string[] {
      return (editor.document as unknown as { type: string }[]).map((b) => b.type);
    }

    it.each(['ArrowDown', 'ArrowRight'])('%s in the last cell opens a line under it and moves there', (key) => {
      const editor = open();
      onEdgeLine(editor);
      caretAfter(editor, 'b2');

      expect(press(editor, key)).toBe(true);

      expect(blockTypes(editor)).toEqual(['table', 'paragraph']);
      expect(editor.prosemirrorState.selection.$head.parent.type.name).toBe('paragraph');
    });

    it('ArrowDown in the last row, not the last cell, opens the line too', () => {
      const editor = open();
      onEdgeLine(editor);
      caretAfter(editor, 'a2');

      press(editor, 'ArrowDown');

      expect(blockTypes(editor)).toEqual(['table', 'paragraph']);
    });

    it.each([
      ['ArrowDown', 'a1'],
      ['ArrowRight', 'a2'],
    ])('%s from %s, which is not on the way out, opens nothing', (key, cell) => {
      const editor = open();
      onEdgeLine(editor);
      caretAfter(editor, cell);

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['table']);
    });

    it('opens nothing when a block already follows the table', () => {
      const editor = open();
      editor.insertBlocks([{ type: 'paragraph', content: 'after' }] as never, editor.document[0]!, 'after');
      onEdgeLine(editor);
      caretAfter(editor, 'b2');

      press(editor, 'ArrowDown');

      expect(blockTypes(editor)).toEqual(['table', 'paragraph']);
    });

    it.each(['ArrowDown', 'ArrowRight'])('%s on a cell line with another line under it opens nothing', (key) => {
      // A pasted cell can hold more than one line; the way out is from its last.
      const editor = open();
      caretAfter(editor, 'b2');
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr.split(view.state.selection.from).insertText('more'));
      caretAfter(editor, 'b2');
      onEdgeLine(editor);

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['table']);
    });

    it('opens nothing when the table has a block nested under it', () => {
      const editor = open();
      editor.updateBlock(editor.document[0]!, { children: [{ type: 'paragraph', content: 'kid' }] } as never);
      onEdgeLine(editor);
      caretAfter(editor, 'b2');

      press(editor, 'ArrowDown');

      expect(blockTypes(editor)).toEqual(['table']);
      expect((editor.document[0] as unknown as { children: unknown[] }).children).toHaveLength(1);
    });
  });

  it('Tab in the last cell adds a row and moves into its first cell', () => {
    const editor = open();
    caretAfter(editor, 'b2');

    press(editor, 'Tab');

    expect(table(editor).childCount).toBe(3);
    expect(table(editor).child(2).childCount).toBe(2);
    const { $head } = editor.prosemirrorState.selection;
    expect($head.node($head.depth - 2)).toBe(table(editor).child(2));
    expect($head.index($head.depth - 2)).toBe(0);
  });

  it.each([false, true])('Enter breaks the line inside the cell (shift: %s)', (shift) => {
    const editor = open();
    caretAfter(editor, 'a1');

    expect(press(editor, 'Enter', shift)).toBe(true);

    expect(table(editor).childCount).toBe(2);
    const cell = table(editor).child(0).child(0);
    expect(cell.childCount).toBe(1);
    const line = cell.firstChild!;
    expect(line.lastChild?.type.name).toBe('hardBreak');
    expect(caretCell(editor)).toBe('a1');
  });

  it('Enter in a quoted table breaks the line and keeps the table whole', () => {
    const editor = open(true);
    caretAfter(editor, 'b2');

    press(editor, 'Enter');

    expect((editor.document as unknown as { type: string }[]).map((b) => b.type)).toEqual([
      'table',
    ]);
    expect(table(editor).child(1).child(1).firstChild?.lastChild?.type.name).toBe('hardBreak');
  });

  it('Enter that ends a composition adds no line break', () => {
    const editor = open();
    caretAfter(editor, 'a1');
    const before = editor.prosemirrorState.doc;

    editor.prosemirrorView!.dom.dispatchEvent(
      new CompositionEvent('compositionend', { data: '你好', bubbles: true }),
    );
    press(editor, 'Enter');

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });
});
