// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A16: a table pasted from a spreadsheet, a web page or markdown
 * lands as our table; block content inside its cells keeps only its words;
 * pasting cells over cells fills them in place.
 *
 * Each paste goes in as a real `paste` event on the editor, so it runs the
 * whole way a reader's paste does: BlockNote's clipboard handler, our
 * comment-stripping transform, and the table plugin's own paste handling.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { heldTables } from '@web/spaces/document/document-table-leave-selection';
import { cellDepthOf } from '@web/spaces/document/document-table-nodes';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding one paragraph with the caret at its end.
 * @param text - The paragraph's words.
 * @returns The editor.
 */
function open(text = 'lead'): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: text }] as never);
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  // A press, a paste or a key in the body lands while it holds the focus.
  editor.prosemirrorView.focus();
  return editor;
}

/**
 * Pastes clipboard data the way a reader's paste delivers it.
 * @param editor - The editor.
 * @param data - The clipboard, by MIME type.
 */
function paste(editor: Editor, data: Record<string, string>): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  // Configurable, as on a browser's event, where the clipboard is a getter on
  // the prototype and the page may put its own value on the event.
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      types: Object.keys(data),
      getData: (type: string): string => data[type] ?? '',
      files: [],
      items: [],
    },
  });
  editor.prosemirrorView.dom.dispatchEvent(event);
}

/**
 * Every table in the document, as cell texts.
 * @param editor - The editor.
 * @returns One grid per table, one array per row.
 */
function tables(editor: Editor): string[][][] {
  const found: string[][][] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name !== 'docTable') return true;
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
    });
    found.push(rows);
    return false;
  });
  return found;
}

/**
 * Every cell's blocks with words in them, in document order.
 * @param editor - The editor.
 * @returns Per cell, each block as `type:words`.
 */
function cellBlocks(editor: Editor): string[][] {
  const cells: string[][] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name !== 'docTableCell' && node.type.name !== 'docTableHeader') return true;
    const blocks: string[] = [];
    node.descendants((inner) => {
      if (inner.isTextblock) blocks.push(`${inner.type.name}:${inner.textContent}`);
      return !inner.isTextblock;
    });
    cells.push(blocks);
    return false;
  });
  return cells;
}


const EXCEL_HTML =
  '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
  '<head><meta name=ProgId content=Excel.Sheet><style>.xl65{mso-number-format:General;}</style></head>' +
  '<body link="#0563C1"><table border=0 cellpadding=0 cellspacing=0 width=174 style="border-collapse:collapse;width:130pt">' +
  '<col width=87 span=2 style="width:65pt">' +
  '<!--StartFragment-->' +
  '<tr height=20 style="height:15.0pt"><td height=20 class=xl65 width=87>name</td><td class=xl65 width=87>qty</td></tr>' +
  '<tr height=20 style="height:15.0pt"><td height=20 class=xl65>apple</td><td class=xl65 align=right>3</td></tr>' +
  '<!--EndFragment-->' +
  '</table></body></html>';

const SHEETS_HTML =
  '<meta charset="utf-8"><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>' +
  '<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" data-sheets-root="1">' +
  '<colgroup><col width="100"/><col width="100"/></colgroup><tbody>' +
  '<tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px;">city</td><td style="overflow:hidden;padding:2px 3px;">pop</td></tr>' +
  '<tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px;">Oslo</td><td style="overflow:hidden;padding:2px 3px;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:7}">7</td></tr>' +
  '</tbody></table></google-sheets-html-origin>';

const WEB_HTML =
  '<table><thead><tr><th>key</th><th>value</th></tr></thead>' +
  '<tbody><tr><td><ul><li>one</li><li>two</li></ul></td><td><p>plain</p><img src="https://example.com/x.png"></td></tr></tbody></table>';

const MARKDOWN = '| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n';

describe('pasting a table from elsewhere (A16)', () => {
  it('lands an Excel range as a table', () => {
    const editor = open();

    paste(editor, { 'text/html': EXCEL_HTML, 'text/plain': 'name\tqty\napple\t3\n' });

    expect(tables(editor)).toEqual([[['name', 'qty'], ['apple', '3']]]);
  });

  it('lands a Google Sheets range as a table', () => {
    const editor = open();

    paste(editor, { 'text/html': SHEETS_HTML, 'text/plain': 'city\tpop\nOslo\t7' });

    expect(tables(editor)).toEqual([[['city', 'pop'], ['Oslo', '7']]]);
  });

  it('lands a web page table as a table, its header row and all', () => {
    const editor = open();

    paste(editor, { 'text/html': WEB_HTML, 'text/plain': 'key\tvalue' });

    expect(tables(editor)).toHaveLength(1);
    expect(tables(editor)[0][0]).toEqual(['key', 'value']);
  });

  it('keeps a list in a pasted cell as a list, and leaves out an image from elsewhere', () => {
    const editor = open();

    paste(editor, { 'text/html': WEB_HTML, 'text/plain': 'key\tvalue' });

    expect(cellBlocks(editor)).toEqual([
      ['paragraph:key'],
      ['paragraph:value'],
      ['bulletListItem:one', 'bulletListItem:two'],
      ['paragraph:plain'],
    ]);
  });

  it('leaves an empty paragraph in a cell that held only an image from elsewhere', () => {
    const editor = open();

    paste(editor, {
      'text/html': '<table><tr><td>a</td><td><img src="https://example.com/x.png"></td></tr></table>',
      'text/plain': 'a',
    });

    expect(cellBlocks(editor)).toEqual([['paragraph:a'], ['paragraph:']]);
    expect(() => editor.prosemirrorState.doc.check()).not.toThrow();
  });

  it('lands a markdown pipe table as a table', () => {
    const editor = open();

    paste(editor, { 'text/plain': MARKDOWN });

    expect(tables(editor)).toEqual([[['h1', 'h2'], ['c1', 'c2']]]);
  });
});

describe('pasting a web table whose grid is not even (A16)', () => {
  it('lands a table whose rowspan runs past its last row, the span cut to the rows there are', () => {
    const editor = open();

    paste(editor, {
      'text/html': '<table><tr><td rowspan="5">tall</td><td>b</td></tr><tr><td>c</td></tr></table>',
      'text/plain': 'tall\tb\nc',
    });

    expect(tables(editor)).toEqual([[['tall', 'b'], ['c']]]);
    let rowspan = 0;
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'docTableCell' && node.textContent === 'tall') rowspan = Number(node.attrs['rowspan']);
      return true;
    });
    expect(rowspan).toBe(2);
  });

  it('keeps the words of a short first row in its first columns', () => {
    const editor = open();

    paste(editor, {
      'text/html': '<table><tr><td>a</td></tr><tr><td>b</td><td>c</td></tr></table>',
      'text/plain': 'a\nb\tc',
    });

    expect(tables(editor)).toEqual([[['a', ''], ['b', 'c']]]);
  });
});

describe('pasting cells over cells (A16)', () => {
  it('fills the cells from the one the caret is in, without nesting a table', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
    ] as never);
    const view = editor.prosemirrorView;
    let a1 = -1;
    view.state.doc.descendants((node, pos) => {
      if (a1 < 0 && node.type.name === 'docTableCell' && node.textContent === 'a1') a1 = pos;
      return a1 < 0;
    });
    let b2 = -1;
    view.state.doc.descendants((node, pos) => {
      if (b2 < 0 && node.type.name === 'docTableCell' && node.textContent === 'b2') b2 = pos;
      return b2 < 0;
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, a1, b2)));

    paste(editor, { 'text/html': SHEETS_HTML, 'text/plain': 'city\tpop\nOslo\t7' });

    expect(tables(editor)).toEqual([[['city', 'pop'], ['Oslo', '7']]]);
  });
});

describe('a table pasted into a line with words (A16)', () => {
  /** A bare web table, nothing around it. */
  const BARE = '<table><tr><td>t1</td><td>t2</td></tr><tr><td>t3</td><td>t4</td></tr></table>';

  /**
   * The body's blocks as `type:words`, a table as its cells.
   * @param editor - The editor.
   * @returns One entry per block.
   */
  const lines = (editor: Editor): string[] => {
    const out: string[] = [];
    editor.prosemirrorView.state.doc.firstChild!.forEach((node) => {
      out.push(node.type.name === 'docTable' ? `table:${node.textContent}` : `${node.firstChild!.type.name}:${node.textContent}`);
    });
    return out;
  };

  it.each([
    ['in the middle, the line split around it', 2, ['paragraph:le', 'table:t1t2t3t4', 'paragraph:ad']],
    ['at the end, under the line', 4, ['paragraph:lead', 'table:t1t2t3t4']],
    ['at the start, above the line', 0, ['table:t1t2t3t4', 'paragraph:lead']],
  ] as const)('lands as a table %s', (_name, offset, expected) => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3 + offset)));

    paste(editor, { 'text/html': BARE, 'text/plain': 't1\tt2\nt3\tt4' });

    expect(lines(editor)).toEqual(expected);
  });
});

describe('a table pasted with the caret in a cell (inner#1619; the rules for pasting into cells are inner#1312)', () => {
  it.each([
    ['a table and a line, in the middle of the cell\'s line', '<table><tr><td>t1</td><td>t2</td></tr></table><p>yl</p>', 2],
    ['two tables and a line, at the start of the cell\'s line', '<table><tr><td>t1</td></tr></table><p>m</p><table><tr><td>u1</td></tr></table>', 0],
  ] as const)('keeps the host table whole: %s', (_name, html, offset) => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['cellw', 'q'] }, { cells: ['r2', 's2'] }] }),
    ] as never);
    const view = editor.prosemirrorView;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === 'cellw') at = pos + offset;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));

    paste(editor, { 'text/html': html, 'text/plain': 'x' });

    const top: string[] = [];
    view.state.doc.firstChild!.forEach((node) => top.push(node.type.name));
    expect(top).toEqual(['blockContainer', 'docTable']);
    expect(view.state.doc.textContent).toContain('q');
    expect(view.state.doc.textContent).toContain('s2');
  });
});

/** The places a table can be pasted, in the body or in a cell. */
const PASTE_PLACES = [
  ['at the start of a line', 'tail', 0],
  ['in the middle of a line', 'tail', 2],
  ['at the end of a line', 'tail', 4],
  ['on an empty line', '', 0],
  ['in a cell', 'tail', 2],
] as const;

/**
 * The position of a textblock holding the given words, empty blocks included.
 * @param editor - The editor.
 * @param words - The block's words.
 * @param offset - The offset into the block.
 * @returns The position.
 */
function pasteAt(editor: Editor, words: string, offset: number): number {
  let found = -1;
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === words) found = pos + 1 + offset;
    return found < 0;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

describe.each(PASTE_PLACES)('the table-paste matrix %s', (place, words, offset) => {
  it.each(['caret', 'held forward', 'held backward'] as const)('keeps tables whole for a %s', (selection) => {
    const editor = open();
    const inCell = place === 'in a cell';
    const old = tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] });
    const last = inCell ? tableBlock({ rows: [{ cells: [words, 'last'] }] }) : { type: 'paragraph', content: words };
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'lead' }, old, last] as never);
    const view = editor.prosemirrorView;
    const at = pasteAt(editor, words, offset);
    const cell = pasteAt(editor, 'a1', 1);
    const held = selection !== 'caret';
    const anchor = held && selection === 'held forward' ? cell : at;
    const head = held && selection === 'held backward' ? cell : at;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
    expect(heldTables(view.state.selection) !== null).toBe(held);

    paste(editor, {
      'text/html': '<table><tr><td>t1</td><td>t2</td></tr><tr><td>t3</td><td>t4</td></tr></table>',
      'text/plain': 't1\tt2\nt3\tt4',
    });

    expect(() => view.state.doc.check()).not.toThrow();
    const nested: string[] = [];
    const top: string[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'docTable' && cellDepthOf(view.state.doc.resolve(pos)) > 0) nested.push(node.textContent);
      return true;
    });
    view.state.doc.firstChild!.forEach((node) => top.push(node.type.name));
    expect(nested).toEqual([]);
    expect(view.state.doc.firstChild!.firstChild!.textContent).toBe('lead');
    if (held) {
      expect(tables(editor)).toEqual([[['t1', 't2'], ['t3', 't4']]]);
      expect(top.filter((type) => type === 'docTable')).toHaveLength(1);
      const suffix = inCell ? '' : words.slice(offset);
      expect(view.state.doc.textContent).toBe(`leadt1t2t3t4${suffix}`);
    } else if (!inCell) {
      expect(tables(editor)).toEqual([[['a1', 'b1'], ['a2', 'b2']], [['t1', 't2'], ['t3', 't4']]]);
      expect(top.filter((type) => type === 'docTable')).toHaveLength(2);
      expect(view.state.doc.textContent).toBe(`leada1b1a2b2${words.slice(0, offset)}t1t2t3t4${words.slice(offset)}`);
    } else {
      // The cell-paste task owns how the incoming grid is fitted into cells.
      expect(top).toEqual(['blockContainer', 'docTable', 'docTable']);
      expect(tables(editor)[0]).toEqual([['a1', 'b1'], ['a2', 'b2']]);
      expect(view.state.doc.textContent).toContain('t1');
    }
  });
});

it('replaces a held table with a pasted table at any offset and in either direction', () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 12 }),
    fc.nat(),
    fc.boolean(),
    (letters, offset, backward) => {
      const words = letters.join('');
      const headOffset = offset % (words.length + 1);
      const editor = open();
      editor.replaceBlocks(editor.document, [
        { type: 'paragraph', content: 'lead' },
        tableBlock({ rows: [{ cells: ['old1', 'old2'] }] }),
        { type: 'paragraph', content: words },
      ] as never);
      const view = editor.prosemirrorView;
      const cell = pasteAt(editor, 'old1', 1);
      const tail = pasteAt(editor, words, headOffset);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, backward ? tail : cell, backward ? cell : tail)));
      expect(heldTables(view.state.selection)).not.toBeNull();

      paste(editor, { 'text/html': '<table><tr><td>new1</td><td>new2</td></tr></table>', 'text/plain': 'new1\tnew2' });

      const body: string[] = [];
      view.state.doc.firstChild!.forEach((node) => body.push(node.type.name));
      expect(body.filter((name) => name === 'docTable')).toHaveLength(1);
      expect(tables(editor)).toEqual([[['new1', 'new2']]]);
      expect(view.state.doc.textContent).toBe(`leadnew1new2${words.slice(headOffset)}`);
      expect(() => view.state.doc.check()).not.toThrow();
      editor.unmount();
      mounted.splice(mounted.indexOf(editor), 1);
    },
  ), { numRuns: 20, seed: 1619 });
});
