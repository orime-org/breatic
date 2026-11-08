// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1239: copying, cutting and pasting a table's rows, columns and whole
 * table from their menus, and handing a row or a column to the Agent.
 *
 * A copy writes what Cmd+C over the same cells writes. "Paste above / below /
 * left / right" inserts the clipboard's table as new rows or columns beside
 * the menu's cell and leaves every existing cell as it was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor, type DocumentEditorOptions } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { selectionItem } from '@web/spaces/document/document-to-agent';
import { setTableTarget } from '@web/spaces/document/document-table-target';
import { insertRow } from '@web/spaces/document/document-table-run';
import {
  copyTableLine,
  cutTableLine,
  pasteTableLines,
  tableLineItem,
  tableLineSelection,
} from '@web/spaces/document/document-table-line-clipboard';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

/** What the last copy put on the clipboard, by type. */
let copied: Record<string, string> = {};

/** What the clipboard hands `navigator.clipboard.read`, by type; null refuses the read. */
let readable: Record<string, string> | null = {};

/** Holds the next read until the test lets it go. */
let readGate: Promise<void> | null = null;

beforeEach(() => {
  copied = {};
  readable = {};
  readGate = null;
  // jsdom has no clipboard: a copy command fires the copy event a browser fires.
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn((command: string) => {
      if (command !== 'copy') return false;
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (format: string, value: string) => {
            copied[format] = value;
          },
          clearData: () => {
            copied = {};
          },
          getData: (format: string) => copied[format] ?? '',
        },
      });
      document.dispatchEvent(event);
      return true;
    }),
  });
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: {
      read: vi.fn(async () => {
        if (readGate !== null) await readGate;
        if (readable === null) throw new DOMException('denied', 'NotAllowedError');
        const data = readable;
        return [
          {
            types: Object.keys(data),
            getType: async (type: string) => new Blob([data[type] ?? ''], { type }),
          },
        ];
      }),
      write: vi.fn(async () => undefined),
    },
  });
});

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor with undo tracking, holding a paragraph, a table and a paragraph.
 * @param table - The table.
 * @param doc - The Yjs document, for a pair of editors.
 * @param media - Where the body hands pasted media, for the cases that read it.
 * @returns The editor and its undo manager.
 */
function open(
  table: TableInput,
  doc = new Y.Doc(),
  media?: DocumentEditorOptions['media'],
): { editor: Editor; manager: Y.UndoManager } {
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension], ...(media === undefined ? {} : { media }) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
    tableBlock(table),
    { type: 'paragraph', content: 'below' },
  ] as never);
  manager.stopCapturing();
  return { editor, manager };
}

/** A 3 × 2 table. */
const SMALL: TableInput = { rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }, { cells: ['a3', 'b3'] }] };

/**
 * The first table in the document.
 * @param editor - The editor.
 * @returns The table node.
 */
function tableOf(editor: Editor): PMNode {
  let found: PMNode | null = null;
  editor.prosemirrorState.doc.descendants((node) => {
    if (found === null && node.type.name === 'docTable') found = node;
    return found === null;
  });
  if (found === null) throw new Error('no table');
  return found;
}

/**
 * The first table's words, cell by cell.
 * @param editor - The editor.
 * @returns A row of words per table row.
 */
function grid(editor: Editor): string[][] {
  const rows: string[][] = [];
  tableOf(editor).forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
}

/**
 * The first table's cells, cell by cell, as they are typed.
 * @param editor - The editor.
 * @returns A row of cell type names per table row.
 */
function cellTypes(editor: Editor): string[][] {
  const rows: string[][] = [];
  tableOf(editor).forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.type.name));
    rows.push(cells);
  });
  return rows;
}

/**
 * The position before the cell holding some words.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The position.
 */
function cellOf(editor: Editor, words: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found < 0 && (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader') && node.textContent === words) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no cell holding ${words}`);
  return found;
}

/**
 * What Cmd+C writes over the editor's selection: a copy event on the body.
 * @param editor - The editor.
 * @returns The clipboard, by type.
 */
function cmdC(editor: Editor): Record<string, string> {
  const data: Record<string, string> = {};
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (format: string, value: string) => {
        data[format] = value;
      },
      clearData: () => undefined,
      getData: (format: string) => data[format] ?? '',
    },
  });
  // A copy in the body lands while it holds the focus.
  editor.prosemirrorView.focus();
  editor.prosemirrorView.dom.dispatchEvent(event);
  return data;
}

/**
 * Hands the clipboard what a copy wrote, as an async read gets it: the HTML
 * and the plain text, never our own type.
 * @param data - What the copy wrote.
 */
function readBack(data: Record<string, string>): void {
  readable = { 'text/html': data['text/html'] ?? '', 'text/plain': data['text/plain'] ?? '' };
}

describe('copying a row, a column or the table from its menu', () => {
  it.each(['row', 'column'] as const)('writes what Cmd+C over the %s writes', async (scope) => {
    const { editor } = open(SMALL);
    const view = editor.prosemirrorView;
    const before = view.state.selection;
    view.dispatch(view.state.tr.setSelection(tableLineSelection(view.state.doc, cellOf(editor, 'a2'), scope)!));
    const expected = cmdC(editor);
    view.dispatch(view.state.tr.setSelection(before));

    expect(await copyTableLine(editor as never, cellOf(editor, 'a2'), scope)).toBe('copied');

    expect(copied).toEqual(expected);
    expect(copied['text/plain']).toContain('a2');
    expect(copied['text/plain']).not.toContain(scope === 'row' ? 'a3' : 'b2');
  });

  it('copies the whole table and nothing around it', async () => {
    const { editor } = open(SMALL);

    expect(await copyTableLine(editor as never, cellOf(editor, 'b2'), 'table')).toBe('copied');

    expect(copied['text/html']).toContain('<table');
    for (const words of ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']) expect(copied['text/html']).toContain(words);
    expect(copied['text/html']).not.toContain('above');
    expect(copied['text/html']).not.toContain('below');
  });

  it('leaves the editor selection where it was', async () => {
    const { editor } = open(SMALL);
    const before = editor.prosemirrorState.selection.toJSON();

    await copyTableLine(editor, cellOf(editor, 'a1'), 'row');

    expect(editor.prosemirrorState.selection.toJSON()).toEqual(before);
  });

  it('falls back to the async clipboard when the copy event never runs', async () => {
    const { editor } = open(SMALL);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob>) {}
    });

    expect(await copyTableLine(editor as never, cellOf(editor, 'a1'), 'row')).toBe('copied');

    expect(navigator.clipboard.write).toHaveBeenCalledOnce();
  });

  it('refuses a row a merged cell reaches out of', async () => {
    const { editor } = open({
      rows: [
        { cells: [{ content: 'm', props: { rowspan: 2 } }, 'b1'] },
        { cells: ['b2'] },
      ],
    });

    expect(tableLineSelection(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'row')).toBeNull();
    expect(await copyTableLine(editor as never, cellOf(editor, 'b1'), 'row')).toBe('merged');
    expect(copied).toEqual({});
  });
});

describe('cutting a row, a column or the table from its menu', () => {
  it('copies the row, deletes it, and one undo brings it back', async () => {
    const { editor, manager } = open(SMALL);

    expect(await cutTableLine(editor as never, cellOf(editor, 'a2'), 'row')).toBe('cut');

    expect(copied['text/plain']).toContain('a2');
    expect(grid(editor)).toEqual([['a1', 'b1'], ['a3', 'b3']]);
    manager.undo();
    expect(grid(editor)).toEqual([['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']]);
  });

  it('deletes the column it copied', async () => {
    const { editor } = open(SMALL);

    await cutTableLine(editor, cellOf(editor, 'b1'), 'column');

    expect(grid(editor)).toEqual([['a1'], ['a2'], ['a3']]);
  });

  it('deletes the table when the cut takes its last row', async () => {
    const { editor } = open({ rows: [{ cells: ['only', 'one'] }] });

    await cutTableLine(editor, cellOf(editor, 'only'), 'row');

    expect(editor.document.some((block) => block.type === 'docTable')).toBe(false);
  });

  it('deletes the whole table it copied', async () => {
    const { editor } = open(SMALL);

    await cutTableLine(editor, cellOf(editor, 'a1'), 'table');

    expect(copied['text/html']).toContain('<table');
    expect(editor.document.some((block) => block.type === 'docTable')).toBe(false);
  });

  it('deletes nothing when neither way of writing the clipboard works', async () => {
    const { editor } = open(SMALL);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob>) {}
    });
    vi.mocked(navigator.clipboard.write).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));

    expect(await cutTableLine(editor as never, cellOf(editor, 'a2'), 'row')).toBe('failed');

    expect(grid(editor)).toHaveLength(3);
  });
});

describe('pasting copied rows and columns as new ones', () => {
  it('inserts the copied row below and leaves every row as it was; one undo takes it out', async () => {
    const { editor, manager } = open(SMALL);
    await copyTableLine(editor, cellOf(editor, 'a1'), 'row');
    readBack(copied);

    expect(await pasteTableLines(editor as never, cellOf(editor, 'a3'), 'below')).toBe('pasted');

    expect(grid(editor)).toEqual([['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3'], ['a1', 'b1']]);
    manager.undo();
    expect(grid(editor)).toEqual([['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']]);
  });

  it('inserts above', async () => {
    const { editor } = open(SMALL);
    await copyTableLine(editor, cellOf(editor, 'a3'), 'row');
    readBack(copied);

    await pasteTableLines(editor, cellOf(editor, 'a1'), 'above');

    expect(grid(editor)).toEqual([['a3', 'b3'], ['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']]);
  });

  it.each([
    ['left', [['b1', 'a1', 'b1'], ['b2', 'a2', 'b2'], ['b3', 'a3', 'b3']]],
    ['right', [['a1', 'b1', 'b1'], ['a2', 'b2', 'b2'], ['a3', 'b3', 'b3']]],
  ] as const)('inserts a copied column to the %s', async (side, expected) => {
    const { editor } = open(SMALL);
    await copyTableLine(editor, cellOf(editor, 'b1'), 'column');
    readBack(copied);

    await pasteTableLines(editor, cellOf(editor, side === 'left' ? 'a1' : 'b1'), side);

    expect(grid(editor)).toEqual(expected);
  });

  it('leaves the missing cells empty when the copied table is narrower', async () => {
    const { editor } = open({ rows: [{ cells: ['a1', 'b1', 'c1'] }] });
    readable = { 'text/html': '<table><tr><td>x</td></tr></table>', 'text/plain': '' };

    await pasteTableLines(editor, cellOf(editor, 'a1'), 'below');

    expect(grid(editor)).toEqual([['a1', 'b1', 'c1'], ['x', '', '']]);
  });

  it('widens the table when the copied rows are wider, the new cells in their place', async () => {
    const { editor } = open({ rows: [{ cells: ['a1'] }, { cells: ['a2'] }] });
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td><td>z</td></tr></table>', 'text/plain': '' };

    await pasteTableLines(editor, cellOf(editor, 'a1'), 'below');

    expect(grid(editor)).toEqual([['a1', '', ''], ['x', 'y', 'z'], ['a2', '', '']]);
  });

  it('makes the first cell of an inserted row a header while the header column is on', async () => {
    const { editor } = open({ ...SMALL, headerCols: 1 });
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td></tr></table>', 'text/plain': '' };

    await pasteTableLines(editor, cellOf(editor, 'a2'), 'below');

    expect(grid(editor)[2]).toEqual(['x', 'y']);
    expect(cellTypes(editor)[2]).toEqual(cellTypes(editor)[1]);
  });

  it('above a header row, makes the cells "insert above" makes', async () => {
    const { editor: pasted } = open({ ...SMALL, headerRows: 1 });
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td></tr></table>', 'text/plain': '' };
    await pasteTableLines(pasted, cellOf(pasted, 'a1'), 'above');
    const { editor: inserted } = open({ ...SMALL, headerRows: 1 });
    insertRow(inserted, cellOf(inserted, 'a1'), 'above');

    expect(grid(pasted)[0]).toEqual(['x', 'y']);
    expect(cellTypes(pasted)).toEqual(cellTypes(inserted));
  });

  it('carries each copied cell colour', async () => {
    const { editor } = open({ rows: [{ cells: [{ content: 'red', props: { backgroundColor: 'red' } }, 'b1'] }] });
    await copyTableLine(editor, cellOf(editor, 'red'), 'row');
    readBack(copied);

    await pasteTableLines(editor, cellOf(editor, 'red'), 'below');

    const second = tableOf(editor).child(1);
    expect(second.child(0).attrs['backgroundColor']).toBe('red');
  });

  it('keeps a list in a copied cell a list when the clipboard also holds its Markdown', async () => {
    const { editor } = open({
      rows: [{ cells: [{ blocks: [{ type: 'bulletListItem', content: 'one' }, { type: 'bulletListItem', content: 'two' }] }, 'b1'] }],
    });
    await copyTableLine(editor, cellOf(editor, 'onetwo'), 'row');
    readBack(copied);

    await pasteTableLines(editor, cellOf(editor, 'b1'), 'below');

    const kinds: string[] = [];
    tableOf(editor).child(1).child(0).descendants((node) => {
      kinds.push(node.type.name);
    });
    expect(kinds.filter((name) => name === 'bulletListItem')).toHaveLength(2);
  });

  it('reads a Markdown table from plain text alone', async () => {
    const { editor } = open(SMALL);
    readable = { 'text/plain': '| x | y |\n| --- | --- |\n| p | q |' };

    expect(await pasteTableLines(editor as never, cellOf(editor, 'a1'), 'above')).toBe('pasted');

    expect(grid(editor).slice(0, 2)).toEqual([['x', 'y'], ['p', 'q']]);
  });

  it('reads the Markdown table when the HTML is a code block of its source', async () => {
    const { editor } = open(SMALL);
    const source = '| x | y |\n| --- | --- |\n| p | q |';
    readable = { 'text/html': `<pre><code>${source}</code></pre>`, 'text/plain': source };

    expect(await pasteTableLines(editor as never, cellOf(editor, 'a1'), 'above')).toBe('pasted');

    expect(grid(editor).slice(0, 2)).toEqual([['x', 'y'], ['p', 'q']]);
  });

  it('turns an outside picture in a copied cell into a pending upload, as Cmd+V does', async () => {
    const start = vi.fn();
    const { editor } = open(SMALL, new Y.Doc(), { assetUrlPrefix: () => 'https://assets.test/', onLeftOut: vi.fn(), start });
    readable = { 'text/html': '<table><tr><td><img src="https://example.com/a.png"></td><td>y</td></tr></table>', 'text/plain': '' };

    await pasteTableLines(editor, cellOf(editor, 'a1'), 'above');

    const images: PMNode[] = [];
    tableOf(editor).child(0).child(0).descendants((node) => {
      if (node.type.name === 'image') images.push(node);
    });
    expect(images).toHaveLength(1);
    expect(images[0].attrs['uploadId']).not.toBe('');
  });

  it('says there is no table to insert, and changes nothing, for other content', async () => {
    const { editor } = open(SMALL);
    readable = { 'text/html': '<p>words</p>', 'text/plain': 'words' };

    expect(await pasteTableLines(editor as never, cellOf(editor, 'a1'), 'below')).toBe('no-table');

    expect(grid(editor)).toHaveLength(3);
  });

  it('says the clipboard could not be read when the browser refuses', async () => {
    const { editor } = open(SMALL);
    readable = null;

    expect(await pasteTableLines(editor as never, cellOf(editor, 'a1'), 'below')).toBe('unreadable');

    expect(grid(editor)).toHaveLength(3);
  });

  it('refuses a row a merged cell reaches out of', async () => {
    const { editor } = open({
      rows: [
        { cells: [{ content: 'm', props: { rowspan: 2 } }, 'b1'] },
        { cells: ['b2'] },
      ],
    });
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td></tr></table>', 'text/plain': '' };

    expect(await pasteTableLines(editor as never, cellOf(editor, 'b1'), 'below')).toBe('merged');
  });

  it('lands beside its own row while another table menu opens and closes during the read', async () => {
    const { editor } = open(SMALL);
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td></tr></table>', 'text/plain': '' };
    let release = (): void => undefined;
    readGate = new Promise((resolve) => {
      release = resolve;
    });

    const pasting = pasteTableLines(editor, cellOf(editor, 'a1'), 'below');
    setTableTarget(editor.prosemirrorView, cellOf(editor, 'a3'), 'row');
    setTableTarget(editor.prosemirrorView, null);
    release();
    await pasting;

    expect(grid(editor)).toEqual([['a1', 'b1'], ['x', 'y'], ['a2', 'b2'], ['a3', 'b3']]);
  });

  it('lands beside its own row when someone inserts a row above it during the read', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const { editor: ours } = open(SMALL, a);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const theirs = buildDocumentEditor({ fragment: documentBodyFragment(b) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    theirs.mount(host);
    mounted.push(theirs);
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td></tr></table>', 'text/plain': '' };
    let release = (): void => undefined;
    readGate = new Promise((resolve) => {
      release = resolve;
    });

    const pasting = pasteTableLines(ours, cellOf(ours, 'a2'), 'below');
    insertRow(theirs, cellOf(theirs, 'a1'), 'above');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'peer');
    release();
    await pasting;

    expect(grid(ours)).toEqual([['', ''], ['a1', 'b1'], ['a2', 'b2'], ['x', 'y'], ['a3', 'b3']]);
  });

  it('inserts nothing, and says nothing, when its row is deleted during the read', async () => {
    const { editor } = open(SMALL);
    readable = { 'text/html': '<table><tr><td>x</td><td>y</td></tr></table>', 'text/plain': '' };
    let release = (): void => undefined;
    readGate = new Promise((resolve) => {
      release = resolve;
    });

    const pasting = pasteTableLines(editor, cellOf(editor, 'a2'), 'below');
    await cutTableLine(editor, cellOf(editor, 'a2'), 'row');
    release();

    expect(await pasting).toBe('gone');
    expect(grid(editor)).toEqual([['a1', 'b1'], ['a3', 'b3']]);
  });
});

describe('handing a row or a column to the Agent', () => {
  it.each(['row', 'column'] as const)('hands the %s as the bubble bar hands the same cells', (scope) => {
    const { editor } = open(SMALL);
    const view = editor.prosemirrorView;
    const pos = cellOf(editor, 'a2');
    const item = tableLineItem(editor, pos, scope);
    view.dispatch(view.state.tr.setSelection(tableLineSelection(view.state.doc, pos, scope)!));

    expect(item).toEqual(selectionItem(editor as never));
  });

  it('hands nothing for a row a merged cell reaches out of', () => {
    const { editor } = open({
      rows: [
        { cells: [{ content: 'm', props: { rowspan: 2 } }, 'b1'] },
        { cells: ['b2'] },
      ],
    });

    expect(tableLineItem(editor as never, cellOf(editor, 'b1'), 'row')).toBeNull();
  });
});

describe('a cell colour in HTML', () => {
  it('is written out and read back', () => {
    const { editor } = open({ rows: [{ cells: [{ content: 'red', props: { backgroundColor: 'red' } }, 'b1'] }] });
    const html = editor.blocksToHTMLLossy(editor.document.filter((block) => block.type === 'docTable'));

    expect(html).toContain('data-background-color="red"');

    const parsed = editor.tryParseHTMLToBlocks(html);
    const table = parsed.find((block) => block.type === 'docTable') as unknown as { children: { children: { props: Record<string, unknown> }[] }[] };
    expect(table.children[0].children[0].props['backgroundColor']).toBe('red');
  });
});

// The cell selection the module reads must be a real one.
it('selects exactly the row the menu stands on', () => {
  const { editor } = open(SMALL);
  const selection = tableLineSelection(editor.prosemirrorState.doc, cellOf(editor, 'b2'), 'row');

  expect(selection).toBeInstanceOf(CellSelection);
  const words: string[] = [];
  selection!.forEachCell((cell) => words.push(cell.textContent));
  expect(words).toEqual(['a2', 'b2']);
});
