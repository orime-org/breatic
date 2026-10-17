// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drop of outside content is a paste at the drop point (inner#1351 +
 * inner#1390 design §5.4.1, A5): read first, then put by the same rules a
 * paste there would follow, the placed content selected, one undo step back
 * to the reader's caret.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { OURS, TABLE, TWO_CELLS, caretIn, firstCell, open, paste, positionOf, select, settled, unmountAll, type Editor } from './paste-harness';

afterEach(unmountAll);

type Block = { type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

const PIC = `${OURS}p.png`;

/**
 * Drops content of these formats at a document position.
 * @param editor - The editor.
 * @param at - Where the pointer is.
 * @param formats - Each format the drag carries, with its data.
 */
function dropFormats(editor: Editor, at: number, formats: Readonly<Record<string, string>>): void {
  const view = editor.prosemirrorView;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 1, clientY: 1 });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: Object.keys(formats), files: [], items: [], getData: (type: string): string => formats[type] ?? '' },
  });
  view.dom.dispatchEvent(event);
}

/**
 * The top-level blocks as labels.
 * @param editor - The editor.
 * @returns `type:words`, `image(url)`, `codeBlock:words`, `table`.
 */
function lines(editor: Editor): string[] {
  return (editor.document as Block[]).map((block) => {
    if (block.type === 'image') return `image(${String(block.props['url'])})`;
    if (block.type === 'table') return 'table';
    const words = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '';
    return `${block.type}:${words}`;
  });
}

/**
 * The selection, as the text it covers or the node it selects.
 * @param editor - The editor.
 * @returns A short description.
 */
function selected(editor: Editor): string {
  const { selection } = editor.prosemirrorView.state;
  if (selection instanceof NodeSelection) return `node:${selection.node.type.name}`;
  if (selection.empty) return `caret:${selection.$head.parent.textContent}@${selection.$head.parentOffset}`;
  return `text:${editor.prosemirrorView.state.doc.textBetween(selection.from, selection.to, '|')}`;
}

describe('content dropped into a line lands as the same content pasted there', () => {
  it.each([
    ['in its middle', 2],
    ['at its start', 0],
    ['at its end', 4],
  ])('%s', async (_name, offset) => {
    const html = `<p>w</p><img src="${PIC}"><p>v</p>`;
    const dropped = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]).editor;
    dropFormats(dropped, positionOf(dropped, 'abcd', offset), { 'text/html': html, 'text/plain': 'w v' });
    await settled();
    const pasted = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]).editor;
    select(pasted, positionOf(pasted, 'abcd', offset));
    paste(pasted, html, 'w v');
    await settled();
    expect(lines(dropped)).toEqual(lines(pasted));
  });

  it('in a table cell', async () => {
    const html = `<p>w</p><img src="${PIC}">`;
    const dropped = open([TABLE, { type: 'paragraph', content: 'tail' }]).editor;
    dropFormats(dropped, positionOf(dropped, 'cell', 2), { 'text/html': html, 'text/plain': 'w' });
    await settled();
    const pasted = open([TABLE, { type: 'paragraph', content: 'tail' }]).editor;
    select(pasted, positionOf(pasted, 'cell', 2));
    paste(pasted, html, 'w');
    await settled();
    expect({ lines: lines(dropped), cell: firstCell(dropped, 0) }).toEqual({ lines: lines(pasted), cell: firstCell(pasted, 0) });
  });
});

describe('a drop selects what it put', () => {
  it('words: the words put, none of the line\'s own', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'abcd' }]);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': '<p>xy</p>', 'text/plain': 'xy' });
    await settled();
    expect(selected(editor)).toBe('text:xy');
  });

  it('a picture alone, into the middle of a line: that picture', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'abcd' }]);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect(selected(editor)).toBe('node:image');
  });

  it('into a table cell with a picture: the words put in the cell, not the picture under the table', async () => {
    const { editor } = open([TABLE, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'cell', 2), { 'text/html': `<p>xy</p><img src="${PIC}">`, 'text/plain': 'xy' });
    await settled();
    expect(selected(editor)).toBe('text:xy');
  });
});

describe('a drop as an undo step', () => {
  it('one undo takes all of it out and puts the caret back where the reader left it', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
    caretIn(editor, 0);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': `<p>w</p><img src="${PIC}">`, 'text/plain': 'w' });
    await settled();
    manager.undo();
    expect({ lines: lines(editor), selected: selected(editor) }).toEqual({
      lines: ['paragraph:lead', 'paragraph:abcd'],
      selected: 'caret:lead@4',
    });
  });

  it('with words selected, undo puts the caret where the selection began', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'lead', 1), positionOf(editor, 'lead', 3))));
    view.focus();
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': `<p>w</p><img src="${PIC}">`, 'text/plain': 'w' });
    await settled();
    manager.undo();
    expect({ lines: lines(editor), selected: selected(editor) }).toEqual({
      lines: ['paragraph:lead', 'paragraph:abcd'],
      selected: 'caret:lead@1',
    });
  });
});

describe('a drop with nothing that can land', () => {
  it('changes nothing in the body, and is told', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'abcd' }]);
    caretIn(editor, 0);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': '<img src="http://e.example/a.png">', 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:abcd']);
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });
});

describe('the formats a drop reads, as a paste reads them', () => {
  it('plain text is read as Markdown', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 4, { 'text/plain': '# Title' });
    await settled();
    expect(lines(editor)).toContain('heading:Title');
  });

  it('code from an editor is one code block, its "<" kept', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 4, {
      'text/plain': 'if (a < b) {}',
      'vscode-editor-data': JSON.stringify({ mode: 'typescript' }),
    });
    await settled();
    expect(lines(editor)).toContain('codeBlock:if (a < b) {}');
  });

  it('content of another body lands as it was', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    const html = editor.blocksToFullHTML([{ type: 'heading', content: 'H', props: { level: 2 } }, { type: 'image', props: { url: PIC } }] as never);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 4, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'H' });
    await settled();
    expect(lines(editor).slice(1, 3)).toEqual(['heading:H', `image(${PIC})`]);
  });
});

describe('a drop between two blocks', () => {
  it('lands there, leaving no empty line', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 2, { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `image(${PIC})`, 'paragraph:tail']);
  });
});

describe('a drop into a code block', () => {
  it.each([
    ['plain text that reads as Markdown goes in as it is', { 'text/plain': '# Title\n- item' }, 'codeBlock:x# Title\n- item'],
    ['web content of words goes in one line each', { 'text/html': '<p>hello</p><p>world</p>', 'text/plain': 'hello\n\nworld' }, 'codeBlock:xhello\nworld'],
  ])('%s, the code block kept whole', async (_name, formats, code) => {
    const { editor } = open([{ type: 'codeBlock', content: 'x' }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, caretIn(editor, 0), formats);
    await settled();
    expect(lines(editor)).toEqual([code, 'paragraph:tail']);
  });
});

describe('a drop into a table cell, what it selects', () => {
  it('a picture alone: the picture under the table', async () => {
    const { editor } = open([TABLE, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'cell', 2), { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect(selected(editor)).toBe('node:image');
  });

  it('a table that fills cells and a picture: the cells it filled', async () => {
    const { editor } = open([TWO_CELLS, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'c1', 2), { 'text/html': `<table><tr><td>x</td><td>y</td></tr></table><img src="${PIC}">`, 'text/plain': 'x y' });
    await settled();
    expect(editor.prosemirrorView.state.selection).toBeInstanceOf(CellSelection);
  });
});

describe('a drop that puts nothing in', () => {
  it('leaves the next edit its own undo step, back to its own caret', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'lead', 1));
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/plain': ' ' });
    await settled();
    select(editor, positionOf(editor, 'abcd', 4));
    editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.insertText('Z'));
    manager.undo();
    expect(selected(editor)).toBe('caret:abcd@4');
  });
});

describe('the line a drop opens between two quoted blocks', () => {
  it('is quoted as they are', async () => {
    const { editor } = open([
      { type: 'paragraph', content: 'a', props: { quoted: true } },
      { type: 'image', props: { url: `${OURS}q.png`, quoted: true } },
      { type: 'paragraph', content: 'b', props: { quoted: true } },
    ]);
    dropFormats(editor, positionOf(editor, 'a', 1) + 2, { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect((editor.document as Block[]).map((block) => `${block.type}:${String(block.props['quoted'])}`)).toEqual([
      'paragraph:true',
      'image:true',
      'paragraph:true',
      'image:true',
      'paragraph:true',
    ]);
  });
});
