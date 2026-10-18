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
import { CellSelection } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

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
    tableBlock({
      rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }],
    }, { quoted }),
  ] as never);
  return editor;
}

/**
 * Puts the caret at the end of a cell's text.
 * @param editor - The editor.
 * @param text - The cell's text.
 */
function caretAfter(editor: Editor, text: string): void {
  const view = editor.prosemirrorView;
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
  const view = editor.prosemirrorView;
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
    if (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader') {
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
    if (found === null && node.type.name === 'docTable') {
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
      editor.prosemirrorView.endOfTextblock = (): boolean => true;
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

      expect(blockTypes(editor)).toEqual(['docTable', 'paragraph']);
      expect(editor.prosemirrorState.selection.$head.parent.type.name).toBe('paragraph');
    });

    it('ArrowDown in the last row, not the last cell, opens the line too', () => {
      const editor = open();
      onEdgeLine(editor);
      caretAfter(editor, 'a2');

      press(editor, 'ArrowDown');

      expect(blockTypes(editor)).toEqual(['docTable', 'paragraph']);
    });

    it.each([
      ['ArrowDown', 'a1'],
      ['ArrowRight', 'a2'],
    ])('%s from %s, which is not on the way out, opens nothing', (key, cell) => {
      const editor = open();
      onEdgeLine(editor);
      caretAfter(editor, cell);

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['docTable']);
    });

    it('opens nothing when a block already follows the table', () => {
      const editor = open();
      editor.insertBlocks([{ type: 'paragraph', content: 'after' }] as never, editor.document[0], 'after');
      onEdgeLine(editor);
      caretAfter(editor, 'b2');

      press(editor, 'ArrowDown');

      expect(blockTypes(editor)).toEqual(['docTable', 'paragraph']);
    });

    it.each(['ArrowDown', 'ArrowRight'])('%s on a block of the last cell with another block under it opens nothing', (key) => {
      // A cell holds blocks; the way out is from its last one.
      const editor = open();
      editor.replaceBlocks(editor.document, [
        tableBlock({
          rows: [
            { cells: ['a1', 'b1'] },
            { cells: ['a2', { blocks: [{ type: 'paragraph', content: 'b2' }, { type: 'paragraph', content: 'more' }] }] },
          ],
        }),
      ] as never);
      caretAfter(editor, 'b2');
      onEdgeLine(editor);

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['docTable']);
    });

    it.each(['ArrowDown', 'ArrowRight'])('%s on a block nested under the last block of the last cell opens the line', (key) => {
      const editor = open();
      editor.replaceBlocks(editor.document, [
        tableBlock({
          rows: [
            {
              cells: [
                'a1',
                {
                  blocks: [
                    { type: 'bulletListItem', content: 'b1', children: [{ type: 'bulletListItem', content: 'kid' }] },
                  ],
                },
              ],
            },
          ],
        }),
      ] as never);
      caretAfter(editor, 'kid');
      onEdgeLine(editor);

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['docTable', 'paragraph']);
    });

    it.each(['ArrowDown', 'ArrowRight'])('%s opens nothing when a divider follows the table', (key) => {
      const editor = open();
      editor.insertBlocks([{ type: 'divider' }] as never, editor.document[0], 'after');
      onEdgeLine(editor);
      caretAfter(editor, 'b2');

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['docTable', 'divider']);
    });

  });

  describe('leaving a table the body starts with', () => {
    /**
     * Stands in for the browser's answer to "is the caret on the cell's edge
     * line", which jsdom cannot give.
     * @param editor - The editor.
     */
    function onEdgeLine(editor: Editor): void {
      editor.prosemirrorView.endOfTextblock = (): boolean => true;
    }

    /**
     * The types of the top-level blocks.
     * @param editor - The editor.
     * @returns Them, in order.
     */
    function blockTypes(editor: Editor): string[] {
      return (editor.document as unknown as { type: string }[]).map((b) => b.type);
    }

    /**
     * Puts the caret at the start of a cell's text.
     * @param editor - The editor.
     * @param text - The cell's text.
     */
    function caretBefore(editor: Editor, text: string): void {
      caretAfter(editor, text);
      const view = editor.prosemirrorView;
      const at = view.state.selection.from - text.length;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    }

    it('ArrowUp in the first row opens a line above it and moves there', () => {
      const editor = open();
      onEdgeLine(editor);
      caretAfter(editor, 'b1');

      expect(press(editor, 'ArrowUp')).toBe(true);

      expect(blockTypes(editor)).toEqual(['paragraph', 'docTable']);
      expect(editor.prosemirrorState.selection.$head.parent.type.name).toBe('paragraph');
    });

    it('ArrowLeft at the start of the first cell opens a line above it', () => {
      const editor = open();
      onEdgeLine(editor);
      caretBefore(editor, 'a1');

      expect(press(editor, 'ArrowLeft')).toBe(true);

      expect(blockTypes(editor)).toEqual(['paragraph', 'docTable']);
    });

    it.each([
      ['ArrowUp', 'a2'],
      ['ArrowLeft', 'b1'],
    ])('%s from %s, which is not on the way out, opens nothing', (key, text) => {
      const editor = open();
      onEdgeLine(editor);
      caretBefore(editor, text);

      press(editor, key);

      expect(blockTypes(editor)).toEqual(['docTable']);
    });

    it('opens nothing when a block comes before the table', () => {
      const editor = open();
      editor.insertBlocks([{ type: 'divider' }] as never, editor.document[0], 'before');
      onEdgeLine(editor);
      caretAfter(editor, 'a1');

      press(editor, 'ArrowUp');

      expect(blockTypes(editor)).toEqual(['divider', 'docTable']);
    });
  });

  it('Tab in the last cell adds a row and moves into its first cell', () => {
    const editor = open();
    caretAfter(editor, 'b2');

    press(editor, 'Tab');

    expect(table(editor).childCount).toBe(3);
    expect(table(editor).child(2).childCount).toBe(2);
    const { $head } = editor.prosemirrorState.selection;
    expect($head.node($head.depth - 3)).toBe(table(editor).child(2));
    expect($head.index($head.depth - 3)).toBe(0);
  });

  /**
   * The texts of the blocks in a cell, nested ones included, in order.
   * @param editor - The editor.
   * @param row - The row index.
   * @param column - The cell index in that row.
   * @returns The texts.
   */
  function cellLines(editor: Editor, row: number, column: number): string[] {
    const lines: string[] = [];
    table(editor).child(row).child(column).descendants((node) => {
      if (node.isTextblock) lines.push(`${node.type.name}:${node.textContent}`);
      return !node.isTextblock;
    });
    return lines;
  }

  /**
   * Opens a table whose first cell holds the given blocks.
   * @param blocks - The first cell's blocks.
   * @returns The editor.
   */
  function openFirstCell(blocks: unknown[]): Editor {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      tableBlock({ rows: [{ cells: [{ blocks }, 'b1'] }, { cells: ['a2', 'b2'] }] }),
    ] as never);
    return editor;
  }

  it('Enter splits the block inside the cell, the way it does in the body', () => {
    const editor = open();
    caretAfter(editor, 'a1');

    press(editor, 'Enter');

    expect(table(editor).childCount).toBe(2);
    expect(cellLines(editor, 0, 0)).toEqual(['paragraph:a1', 'paragraph:']);
    expect(caretCell(editor)).toBe('a1');
    expect(editor.prosemirrorState.selection.$head.parent.content.size).toBe(0);
  });

  it('Shift-Enter breaks the line inside the cell, the way it does in the body', () => {
    const editor = open();
    caretAfter(editor, 'a1');

    press(editor, 'Enter', true);

    expect(cellLines(editor, 0, 0)).toHaveLength(1);
    expect(table(editor).child(0).child(0).firstChild?.firstChild?.lastChild?.type.name).toBe('hardBreak');
  });

  it('Enter in a list item in a cell starts the next item there', () => {
    const editor = openFirstCell([{ type: 'bulletListItem', content: 'one' }]);
    caretAfter(editor, 'one');

    press(editor, 'Enter');

    expect(cellLines(editor, 0, 0)).toEqual(['bulletListItem:one', 'bulletListItem:']);
  });

  it('Enter on an empty last paragraph of a cell stays in the cell', () => {
    const editor = openFirstCell([{ type: 'paragraph', content: 'one' }, { type: 'paragraph' }]);
    const view = editor.prosemirrorView;
    let last = -1;
    table(editor).child(0).child(0).descendants((node, pos) => {
      if (node.isTextblock) last = pos;
      return !node.isTextblock;
    });
    let cellStart = -1;
    view.state.doc.descendants((node, pos) => {
      if (cellStart < 0 && node.type.name === 'docTableCell') cellStart = pos;
      return cellStart < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellStart + 1 + last + 1)));

    press(editor, 'Enter');

    expect(cellLines(editor, 0, 0)).toEqual(['paragraph:one', 'paragraph:', 'paragraph:']);
    expect((editor.document as unknown as { type: string }[]).map((b) => b.type)).toEqual(['docTable']);
  });

  it.each([false, true])('Enter over several selected cells changes nothing (shift: %s)', (shift) => {
    const editor = open();
    const view = editor.prosemirrorView;
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'docTableCell') cells.push(pos);
      return true;
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0], cells[3])));
    const before = view.state.doc;

    expect(press(editor, 'Enter', shift)).toBe(true);

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('Enter in a quoted table splits the block and keeps the table whole', () => {
    const editor = open(true);
    caretAfter(editor, 'b2');

    press(editor, 'Enter');

    expect((editor.document as unknown as { type: string }[]).map((b) => b.type)).toEqual(['docTable']);
    expect(cellLines(editor, 1, 1)).toEqual(['paragraph:b2', 'paragraph:']);
  });

  it('Tab in a list item that can go in nests it, and stays in the cell', () => {
    const editor = openFirstCell([
      { type: 'bulletListItem', content: 'one' },
      { type: 'bulletListItem', content: 'two' },
    ]);
    caretAfter(editor, 'two');

    expect(press(editor, 'Tab')).toBe(true);

    const first = table(editor).child(0).child(0);
    expect(first.childCount).toBe(1);
    expect(first.firstChild?.lastChild?.type.name).toBe('blockGroup');
    expect(caretCell(editor)).toBe('onetwo');
  });

  it('Tab in a list item that cannot go in moves to the next cell', () => {
    const editor = openFirstCell([{ type: 'bulletListItem', content: 'one' }]);
    caretAfter(editor, 'one');

    press(editor, 'Tab');

    expect(caretCell(editor)).toBe('b1');
  });

  it('Shift-Tab in a nested list item takes it out, and stays in the cell', () => {
    const editor = openFirstCell([
      {
        type: 'bulletListItem',
        content: 'one',
        children: [{ type: 'bulletListItem', content: 'two' }],
      },
    ]);
    caretAfter(editor, 'two');

    press(editor, 'Tab', true);

    expect(table(editor).child(0).child(0).childCount).toBe(2);
    expect(caretCell(editor)).toBe('onetwo');
  });

  it('Shift-Tab in a list item at the top of a cell moves to the previous cell', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      tableBlock({ rows: [{ cells: ['a1', { blocks: [{ type: 'bulletListItem', content: 'one' }] }] }] }),
    ] as never);
    caretAfter(editor, 'one');

    press(editor, 'Tab', true);

    expect(caretCell(editor)).toBe('a1');
  });

  it('Enter that ends a composition adds no line break', () => {
    const editor = open();
    caretAfter(editor, 'a1');
    const before = editor.prosemirrorState.doc;

    editor.prosemirrorView.dom.dispatchEvent(
      new CompositionEvent('compositionend', { data: '你好', bubbles: true }),
    );
    press(editor, 'Enter');

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });
});

describe('the edges of a cell (inner#1619 design 5.3)', () => {
  /**
   * Opens a paragraph, a 2 × 2 table, and a paragraph.
   * @param first - The first cell's blocks, when not one paragraph `a1`.
   * @returns The editor.
   */
  function openAround(first?: unknown[]): Editor {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'above' },
      tableBlock({ rows: [{ cells: [first === undefined ? 'a1' : { blocks: first }, 'b1'] }, { cells: ['a2', 'b2'] }] }),
      { type: 'paragraph', content: 'below' },
    ] as never);
    return editor;
  }

  /**
   * Puts the caret at a text's start.
   * @param editor - The editor.
   * @param text - The text.
   */
  function caretAt(editor: Editor, text: string): void {
    caretAfter(editor, text);
    const view = editor.prosemirrorView;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from - text.length)),
    );
  }

  it.each(['a1', 'b2'])('Backspace at the start of the paragraph that opens cell %s does nothing', (text) => {
    const editor = openAround();
    caretAt(editor, text);
    const before = editor.prosemirrorState;

    press(editor, 'Backspace');

    expect(editor.prosemirrorState.doc.eq(before.doc)).toBe(true);
    expect(editor.prosemirrorState.selection.eq(before.selection)).toBe(true);
  });

  it('Backspace at the start of a heading that opens a cell turns it into a paragraph, in the cell', () => {
    const editor = openAround([{ type: 'heading', props: { level: 2 }, content: 'title' }]);
    caretAt(editor, 'title');

    press(editor, 'Backspace');

    expect(cellBlockTypes(editor, 0)).toEqual(['paragraph']);
    expect(caretCell(editor)).toBe('title');
  });

  it('Backspace between two paragraphs of a cell joins them, the way it does in the body', () => {
    const editor = openAround([
      { type: 'paragraph', content: 'one' },
      { type: 'paragraph', content: 'two' },
    ]);
    caretAt(editor, 'two');

    press(editor, 'Backspace');

    expect(cellBlockTypes(editor, 0)).toEqual(['paragraph']);
    expect(caretCell(editor)).toBe('onetwo');
  });

  it.each(['a1', 'b2'])('Delete at the end of the last block of cell %s does nothing', (text) => {
    const editor = openAround();
    caretAfter(editor, text);
    const before = editor.prosemirrorState;

    press(editor, 'Delete');

    expect(editor.prosemirrorState.doc.eq(before.doc)).toBe(true);
  });

  it('Backspace at the start of the block under the table moves the caret to the end of the last cell', () => {
    const editor = openAround();
    caretAt(editor, 'below');
    const before = editor.prosemirrorState.doc;

    press(editor, 'Backspace');

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
    const { selection } = editor.prosemirrorState;
    expect(selection.empty).toBe(true);
    expect(caretCell(editor)).toBe('b2');
    expect(selection.$head.parentOffset).toBe(2);
  });

  it('Delete at the end of the block above the table does nothing', () => {
    const editor = openAround();
    caretAfter(editor, 'above');
    const before = editor.prosemirrorState.doc;

    press(editor, 'Delete');

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });
});

/**
 * The types of the blocks in a cell of the first row.
 * @param editor - The editor.
 * @param column - The cell's index.
 * @returns Their content node types.
 */
function cellBlockTypes(editor: Editor, column: number): string[] {
  const types: string[] = [];
  table(editor).child(0).child(column).forEach((container) => types.push(container.firstChild!.type.name));
  return types;
}

describe('a quote in a cell (inner#1619 design 5.3)', () => {
  it('Enter on an empty quoted line at the top of a cell opens another quoted line in the cell', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      tableBlock({
        rows: [
          {
            cells: [
              {
                blocks: [
                  { type: 'paragraph', content: 'q', props: { quoted: true } },
                  { type: 'paragraph', props: { quoted: true } },
                ],
              },
              'b',
            ],
          },
        ],
      }),
    ] as never);
    const view = editor.prosemirrorView;
    const cell = table(editor).child(0).child(0);
    let tablePos = -1;
    view.state.doc.descendants((node, pos) => {
      if (tablePos < 0 && node.type.name === 'docTable') tablePos = pos;
      return tablePos < 0;
    });
    // Table, row and cell each open one level; past the first block, into
    // the second's container and its paragraph.
    const emptyLine = tablePos + 1 + 1 + 1 + cell.child(0).nodeSize + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, emptyLine)));

    press(editor, 'Enter');

    const quoted: boolean[] = [];
    table(editor).child(0).child(0).forEach((container) => quoted.push(container.firstChild!.attrs['quoted'] === true));
    expect(quoted).toEqual([true, true, true]);
  });
});

