// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A3 and A4: Tab and Shift-Tab move between cells, Tab in the last
 * cell adds a row, and Enter breaks the line inside the cell.
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
