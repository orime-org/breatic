// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Content holding media pasted into cells or code (inner#1351 + inner#1390
 * design §5.4.3, §5.4.7): a cell holds ordinary blocks; a code block takes
 * words raw and keeps media beside it.
 */

import { tableBlock } from './table-fixtures';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CellSelection } from '@tiptap/pm/tables';

import { serializeClipboard, type ClipboardNode } from '@web/spaces/canvas/node-clipboard';

import { OURS, caretIn, firstCell, open as openBody, paste, pasteFormats, positionOf, select, settled, unmountAll, type Editor } from './paste-harness';

afterEach(unmountAll);

type Block = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

const PIC = `${OURS}p.png`;
const TABLE = (words: string): unknown => tableBlock({ rows: [{ cells: [words, 'y'] }] });

/**
 * Opens a body that also takes canvas pastes.
 * @param blocks - The document.
 * @returns The editor and its undo manager.
 */
function open(blocks: unknown[]): ReturnType<typeof openBody> {
  return openBody(blocks, { onCanvasPaste: { start: vi.fn(), notPasted: vi.fn() } });
}

/**
 * Every top-level block as a label, children indented.
 * @param editor - The editor.
 * @returns `type[q]:words`, `image(url)[q]`, `table[q]`.
 */
function lines(editor: Editor): string[] {
  const label = (block: Block): string => {
    const quoted = block.props['quoted'] === true ? '[q]' : '';
    if (block.type === 'image') {
      const pending = block.props['uploadId'] !== '' && block.props['uploadId'] !== undefined;
      return `image(${pending ? 'pending' : String(block.props['url'])})${quoted}`;
    }
    if (block.type === 'table' || block.type === 'docTable') return `table${quoted}`;
    const words = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '';
    return `${block.type}${quoted}:${words}`;
  };
  const walk = (blocks: Block[], depth: number): string[] =>
    blocks.flatMap((block) => [`${'  '.repeat(depth)}${label(block)}`, ...walk(block.type === 'docTable' ? [] : block.children ?? [], depth + 1)]);
  return walk(editor.document, 0);
}

/**
 * The ordinary blocks in a new table's cell, with nested blocks retained.
 * @param editor - The editor.
 * @param index - The cell in row order.
 * @returns Its block labels.
 */
function cellLines(editor: Editor, index = 0): string[] {
  const table = (editor.document as Block[]).find((block) => block.type === 'docTable')!;
  const cells = table.children!.flatMap((row) => row.children!);
  const walk = (blocks: readonly Block[], depth: number): string[] => blocks.flatMap((block) => {
    const text = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((part) => part.text ?? '').join('') : '';
    const label = block.type === 'image' ? `image(${block.props['uploadId'] ? 'pending' : String(block.props['url'])})` : `${block.type}:${text}`;
    return [`${'  '.repeat(depth)}${label}`, ...walk(block.children ?? [], depth + 1)];
  });
  return walk(cells[index]!.children ?? [], 0);
}

/**
 * Where the caret is: the words of its line and its offset in them.
 * @param editor - The editor.
 * @returns `words@offset`.
 */
function caret(editor: Editor): string {
  const { $head } = editor.prosemirrorView.state.selection;
  return `${$head.parent.textContent}@${$head.parentOffset}`;
}

/**
 * A canvas clipboard holding one picture node.
 * @returns Its plain text.
 */
function canvasPicture(): string {
  const nodes = [{ id: 'i', type: 'image', position: { x: 0, y: 0 }, height: 100, data: { content: PIC } }] as ClipboardNode[];
  return serializeClipboard({ version: 2, picked: ['i'], nodes, edges: [] });
}

describe('content with words and a picture, the caret in a table cell', () => {
  it.each([
    ['web content', (editor: Editor): void => paste(editor, `<p>w</p><img src="${PIC}">`, 'w')],
    [
      'the body\'s own content',
      (editor: Editor): void => {
        const html = editor.blocksToFullHTML([{ type: 'paragraph', content: 'w' }, { type: 'image', props: { url: PIC } }] as never);
        pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'w' });
      },
    ],
  ])('from %s keeps the words, picture and following caret in the cell', async (_name, put) => {
    const { editor, manager } = open([TABLE('x'), { type: 'paragraph', content: 'tail' }]);
    await settled();
    caretIn(editor, 0);
    put(editor);
    await settled();
    expect(firstCell(editor, 0)).toBe('xw');
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
    expect(cellLines(editor)).toEqual(['paragraph:xw', `image(${PIC})`, 'paragraph:']);
    expect(caret(editor)).toBe('@0');
    manager.undo();
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
    expect(firstCell(editor, 0)).toBe('x');
    expect(caret(editor)).toBe('x@1');
  });
});

describe('a picture alone, the caret in a table cell', () => {
  it.each([
    ['web content', (editor: Editor): void => paste(editor, `<img src="${PIC}">`, '')],
    ['a canvas node', (editor: Editor): void => pasteFormats(editor, { 'text/plain': canvasPicture() })],
  ])('from %s lands after the cell text within the same cell', async (_name, put) => {
    const { editor } = open([TABLE('x'), { type: 'paragraph', content: 'tail' }]);
    await settled();
    caretIn(editor, 0);
    put(editor);
    await settled();
    expect(firstCell(editor, 0)).toBe('x');
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
    expect(cellLines(editor)[0]).toBe('paragraph:x');
    expect(cellLines(editor)[1]).toMatch(/^image\(/);
    expect(cellLines(editor)[2]).toBe('paragraph:');
  });
});

describe('the table whose cells take the media', () => {
  it('keeps nested blocks before media inserted at the end of their parent line', async () => {
    const { editor } = open([
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'paragraph', content: 'x', children: [{ type: 'paragraph', content: 'kid' }] }] }, 'y'] }] }),
      { type: 'paragraph', content: 'tail' },
    ]);
    await settled();
    caretIn(editor, 0);
    paste(editor, `<p>w</p><img src="${PIC}">`, 'w');
    await settled();
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
    expect(cellLines(editor)).toEqual(['paragraph:xw', '  paragraph:kid', `image(${PIC})`, 'paragraph:']);
  });

  it('retains the table quote while the media stay in its cell', async () => {
    const { editor } = open([{ ...(TABLE('x') as object), props: { quoted: true } }, { type: 'paragraph', content: 'tail' }]);
    await settled();
    caretIn(editor, 0);
    paste(editor, `<p>w</p><img src="${PIC}">`, 'w');
    await settled();
    expect(lines(editor)).toEqual(['table[q]', 'paragraph:tail']);
    expect(cellLines(editor)).toEqual(['paragraph:xw', `image(${PIC})`, 'paragraph:']);
  });

  it('fills each selected cell with its own media blocks', async () => {
    const { editor } = open([TABLE('x'), { type: 'paragraph', content: 'tail' }]);
    await settled();
    const view = editor.prosemirrorView;
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'docTableCell') cells.push(pos);
      return true;
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[1]!)));
    view.focus();
    paste(editor, `<p>w</p><img src="${PIC}"><img src="${OURS}q.png">`, 'w');
    await settled();
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
    expect(cellLines(editor, 0)).toEqual(['paragraph:w', `image(${PIC})`, `image(${OURS}q.png)`, 'paragraph:']);
    expect(cellLines(editor, 1)).toEqual(['paragraph:w', `image(${PIC})`, `image(${OURS}q.png)`]);
  });

  it('replaces both whole tables when a selection runs from one into the other', async () => {
    const { editor, manager } = open([TABLE('ab'), TABLE('cd'), { type: 'paragraph', content: 'tail' }]);
    await settled();
    select(editor, positionOf(editor, 'ab', 1), positionOf(editor, 'cd', 1));
    const before = editor.prosemirrorView.state.doc;
    paste(editor, `<p>w</p><img src="${PIC}">`, 'w');
    await settled();
    expect(lines(editor)).toEqual(['paragraph:w', `image(${PIC})`, 'paragraph:tail']);
    manager.undo();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before.toJSON());
  });
});

describe('content with a picture, in a code block', () => {
  it('from web content: the words go into the code, the picture under the code block', async () => {
    const { editor } = open([{ type: 'codeBlock', content: 'x = 1' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    paste(editor, `<p>w</p><img src="${PIC}">`, 'w');
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:x = 1w', `image(${PIC})`, 'paragraph:tail']);
  });

  it('from the body\'s own content: the picture shows once, never as Markdown in the code', async () => {
    const { editor } = open([{ type: 'codeBlock', content: 'x = 1' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    const html = editor.blocksToFullHTML([{ type: 'paragraph', content: 'lead' }, { type: 'image', props: { url: PIC, name: 'pic' } }] as never);
    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': `lead\n\n![pic](${PIC})\n` });
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:x = 1lead', `image(${PIC})`, 'paragraph:tail']);
  });

  it('from plain text that reads as Markdown: the text goes in as it is, no picture', async () => {
    const { editor } = open([{ type: 'codeBlock', content: '' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    paste(editor, '', `# Title\n![x](${PIC})`);
    await settled();
    expect(lines(editor)).toEqual([`codeBlock:# Title\n![x](${PIC})`, 'paragraph:tail']);
  });

  it('empty, a picture alone lands above it and the caret stays in it', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'codeBlock', content: '' }]);
    caretIn(editor, 1);
    pasteFormats(editor, { 'text/plain': canvasPicture() });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', 'image(pending)', 'codeBlock:']);
    expect(editor.prosemirrorView.state.selection.$head.parent.type.name).toBe('codeBlock');
  });

  it('a selection running from the code into the next line is judged after it is deleted', async () => {
    const { editor } = open([{ type: 'codeBlock', content: 'code line' }, { type: 'paragraph', content: 'para text' }]);
    select(editor, positionOf(editor, 'code line', 2), positionOf(editor, 'para text', 2));
    paste(editor, `<p><b>w</b></p><img src="${PIC}">`, 'w');
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:cowra text', `image(${PIC})`, 'paragraph:']);
  });
});

describe('only words, or media that do not land, pasted in a code block', () => {
  it('web content whose picture does not land puts its words in the code, one line each, and tells the picture left out', async () => {
    const { editor, sink } = open([{ type: 'codeBlock', content: 'x' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    paste(editor, '<p>a</p><img src="http://e.example/a.png"><p>b</p>', 'a b');
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:xa\nb', 'paragraph:tail']);
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });

  it('plain text with a Markdown picture that does not land goes in as it is, nothing told left out', async () => {
    const { editor, sink } = open([{ type: 'codeBlock', content: 'x' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    paste(editor, '', '# T\n![a](http://e.example/a.png)');
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:x# T\n![a](http://e.example/a.png)', 'paragraph:tail']);
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it('a table puts its words in the code, a tab between cells', async () => {
    const { editor } = open([{ type: 'codeBlock', content: 'x' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    paste(editor, '<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>', 'a1\tb1\na2\tb2');
    await settled();
    expect(lines(editor)).toEqual(['codeBlock:xa1\tb1\na2\tb2', 'paragraph:tail']);
  });
});

describe('code from an editor, pasted', () => {
  it('is one code block, its tags kept', async () => {
    const { editor } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/plain': 'const el = <div>hi</div>;\nif (a<b) x();', 'vscode-editor-data': '{"mode":"typescript"}' });
    await settled();
    expect(lines(editor)).toContain('codeBlock:const el = <div>hi</div>;\nif (a<b) x();');
  });

  it.each([
    ['no mode', '{"version":1,"mode":null}'],
    ['broken data', '{not json'],
    ['a null object', 'null'],
  ])('with %s, pastes the text as plain text', async (_name, data) => {
    const { editor } = open([{ type: 'paragraph' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/plain': 'const a = 1;', 'vscode-editor-data': data });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:const a = 1;', 'paragraph:tail']);
  });
});

describe('words selected in a table cell, a picture alone pasted', () => {
  it.each([
    ['web content', (editor: Editor): void => paste(editor, `<img src="${PIC}">`, '')],
    ['a canvas node', (editor: Editor): void => pasteFormats(editor, { 'text/plain': canvasPicture() })],
  ])('from %s replaces only the selected words inside the cell', async (_name, put) => {
    const { editor } = open([TABLE('xyz'), { type: 'paragraph', content: 'tail' }]);
    await settled();
    select(editor, positionOf(editor, 'xyz', 1), positionOf(editor, 'xyz', 2));
    put(editor);
    await settled();
    expect(firstCell(editor, 0)).toBe('xz');
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
    expect(cellLines(editor)[0]).toBe('paragraph:x');
    expect(cellLines(editor)[1]).toMatch(/^image\(/);
    expect(cellLines(editor)[2]).toBe('paragraph:z');
  });
});
