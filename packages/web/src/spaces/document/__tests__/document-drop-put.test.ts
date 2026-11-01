// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drop of outside content is a paste at the drop point (inner#1351 +
 * inner#1390 design §5.4.1, A5): read first, then put by the same rules a
 * paste there would follow, the placed content selected, one undo step back
 * to the reader's caret.
 */

import { act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { cellAround } from '@tiptap/pm/tables';

import { toast } from '@web/lib/toast';
import { tableBlock } from './table-fixtures';

import { OURS, TABLE, TWO_CELLS, caretIn, firstCell, open, paste, pasteFormats, positionOf, select, settled, unmountAll, type Editor } from './paste-harness';

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

type Block = { type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

const PIC = `${OURS}p.png`;

/**
 * Lets initial view mutations finish before the reader selects or drops.
 * @param blocks - The initial document.
 * @returns The mounted body and its upload and undo controls.
 */
async function openReady(blocks: Parameters<typeof open>[0]): Promise<ReturnType<typeof open>> {
  const opened = open(blocks);
  await act(async () => { await settled(); });
  return opened;
}

/**
 * Drops content of these formats at a document position.
 * @param editor - The editor.
 * @param at - Where the pointer is.
 * @param formats - Each format the drag carries, with its data.
 * @param clientX - The pointer's x: inside the body's 0..100 box, or beside it.
 */
function dropFormats(editor: Editor, at: number, formats: Readonly<Record<string, string>>, clientX = 1): void {
  const view = editor.prosemirrorView;
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, clientY: 1 });
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
    if (block.type === 'table' || block.type === 'docTable') return 'table';
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
    const dropped = (await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }])).editor;
    dropFormats(dropped, positionOf(dropped, 'abcd', offset), { 'text/html': html, 'text/plain': 'w v' });
    await settled();
    const pasted = (await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }])).editor;
    select(pasted, positionOf(pasted, 'abcd', offset));
    paste(pasted, html, 'w v');
    await settled();
    expect(lines(dropped)).toEqual(lines(pasted));
  });

  it('in a table cell', async () => {
    const html = `<p>w</p><img src="${PIC}">`;
    const dropped = (await openReady([TABLE, { type: 'paragraph', content: 'tail' }])).editor;
    dropFormats(dropped, positionOf(dropped, 'cell', 2), { 'text/html': html, 'text/plain': 'w' });
    await settled();
    const pasted = (await openReady([TABLE, { type: 'paragraph', content: 'tail' }])).editor;
    select(pasted, positionOf(pasted, 'cell', 2));
    paste(pasted, html, 'w');
    await settled();
    expect({ lines: lines(dropped), cell: firstCell(dropped, 0) }).toEqual({ lines: lines(pasted), cell: firstCell(pasted, 0) });
  });
});

describe('a drop selects what it put', () => {
  it('words: the words put, none of the line\'s own', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }]);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': '<p>xy</p>', 'text/plain': 'xy' });
    await settled();
    expect(selected(editor)).toBe('text:xy');
  });

  it('a picture alone, into the middle of a line: that picture', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }]);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect(selected(editor)).toBe('node:image');
  });

  it('into a table cell with a picture: selects the inserted words and media, without neighbouring words', async () => {
    const { editor } = await openReady([TABLE, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'cell', 2), { 'text/html': `<p>xy</p><img src="${PIC}">`, 'text/plain': 'xy' });
    await settled();
    const { doc, selection } = editor.prosemirrorView.state;
    expect(selection.empty).toBe(false);
    expect(doc.textBetween(selection.from, selection.to, '')).toBe('xy');
    const media: string[] = [];
    selection.content().content.descendants((node) => {
      if (node.type.name === 'image') media.push(String(node.attrs['url']));
      return true;
    });
    expect(media).toEqual([PIC]);
    expect(lines(editor)).toEqual(['table', 'paragraph:tail']);
  });

  const SECOND = `${OURS}q.png`;

  it.each([
    ['a picture then words, into the middle of a line', [{ type: 'paragraph', content: 'abcd' }], 'abcd', 2, `<img src="${PIC}"><p>v</p>`, 'v', [PIC]],
    ['two pictures, into the middle of a line', [{ type: 'paragraph', content: 'abcd' }], 'abcd', 2, `<img src="${PIC}"><img src="${SECOND}">`, '', [PIC, SECOND]],
    ['a picture then words, into the middle of a cell', [TABLE, { type: 'paragraph', content: 'tail' }], 'cell', 2, `<img src="${PIC}"><p>v</p>`, 'v', [PIC]],
  ] as const)('%s: the leading media and the words, none of the line\'s own', async (_name, blocks, line, offset, html, words, media) => {
    const { editor } = await openReady(blocks as unknown as Parameters<typeof open>[0]);
    dropFormats(editor, positionOf(editor, line, offset), { 'text/html': html, 'text/plain': words });
    await settled();
    expect(selectedContent(editor)).toEqual({ oneCell: true, words, media });
  });

  it.each([
    ['a picture then words at the start of the body', [{ type: 'paragraph', content: 'abcd' }], 'abcd', `<img src="${PIC}"><p>v</p>`],
    ['a picture then words at the start of a second cell', [TWO_CELLS], 'c2', `<img src="${PIC}"><p>v</p>`],
    ['words then a picture at the start of a line', [{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }], 'abcd', `<p>v</p><img src="${PIC}">`],
    ['words then a picture at the start of a second cell', [TWO_CELLS], 'c2', `<p>v</p><img src="${PIC}">`],
  ] as const)('%s: the words, the picture at the line\'s edge outside', async (_name, blocks, line, html) => {
    const { editor } = await openReady(blocks as unknown as Parameters<typeof open>[0]);
    dropFormats(editor, positionOf(editor, line, 0), { 'text/html': html, 'text/plain': 'v' });
    await settled();
    expect(selectedContent(editor)).toEqual({ oneCell: true, words: 'v', media: [] });
  });

  it.each([
    ['media then words, at the end of a line', 'A', 1, `<img src="${PIC}"><p>x</p>`],
    ['media then words, at the start of a line', 'B', 0, `<img src="${PIC}"><p>x</p>`],
    ['words then media, at the end of a line', 'A', 1, `<p>x</p><img src="${PIC}">`],
  ] as const)('%s: deleting what it selected leaves the two lines apart', async (_name, line, offset, html) => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'A' }, { type: 'paragraph', content: 'B' }]);
    dropFormats(editor, positionOf(editor, line, offset), { 'text/html': html, 'text/plain': 'x' });
    await settled();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.deleteSelection());
    expect(lines(editor).filter((label) => label.startsWith('paragraph:') && label !== 'paragraph:')).toEqual(['paragraph:A', 'paragraph:B']);
  });

  it('words then a picture at the end of a line with nested lines: never the nested lines', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'aaa', children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'aaa', 3), { 'text/html': `<p>n</p><img src="${PIC}">`, 'text/plain': 'n' });
    await settled();
    expect(selectedContent(editor)).toEqual({ oneCell: true, words: '', media: [PIC] });
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.deleteSelection());
    expect(view.state.doc.textContent).toBe('aaankidtail');
  });

  it('media then words at the end of a cell: deleting it keeps the cell\'s own words', async () => {
    const { editor } = await openReady([TWO_CELLS]);
    dropFormats(editor, positionOf(editor, 'c1', 2), { 'text/html': `<img src="${PIC}"><p>x</p>`, 'text/plain': 'x' });
    await settled();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.deleteSelection());
    expect(view.state.doc.textContent).toBe('c1c2');
  });

  it('two pictures between two blocks: a caret, not a range into either line', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 2, { 'text/html': `<img src="${PIC}"><img src="${SECOND}">`, 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `image(${PIC})`, `image(${SECOND})`, 'paragraph:tail']);
    expect(editor.prosemirrorView.state.selection.empty).toBe(true);
  });

  it('beside the body: the words and media put, not a caret', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }]);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': `<p>x</p><img src="${PIC}"><p>y</p>`, 'text/plain': 'x y' }, 200);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:abx', `image(${PIC})`, 'paragraph:ycd']);
    expect(selectedContent(editor)).toEqual({ oneCell: true, words: 'xy', media: [PIC] });
  });
});

/**
 * What the selection holds: whether both its ends are in one cell (or both
 * outside any), its words, and the media inside it in order.
 * @param editor - The editor.
 * @returns Whether the ends share a cell, the words and the media addresses.
 */
function selectedContent(editor: Editor): { oneCell: boolean; words: string; media: string[] } {
  const { doc, selection } = editor.prosemirrorView.state;
  const media: string[] = [];
  selection.content().content.descendants((node) => {
    if (node.type.name === 'image') media.push(String(node.attrs['url']));
    return true;
  });
  const oneCell = cellAround(selection.$anchor)?.pos === cellAround(selection.$head)?.pos;
  return { oneCell, words: doc.textBetween(selection.from, selection.to, ''), media };
}

describe('a drop as an undo step', () => {
  it('one undo takes all of it out and puts the caret back where the reader left it', async () => {
    const { editor, manager } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
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
    const { editor, manager } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
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
    const { editor, sink } = await openReady([{ type: 'paragraph', content: 'abcd' }]);
    caretIn(editor, 0);
    dropFormats(editor, positionOf(editor, 'abcd', 2), { 'text/html': '<img src="http://e.example/a.png">', 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:abcd']);
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });

  /**
   * Where the first block of a type starts.
   * @param editor - The editor.
   * @param name - The node type.
   * @returns Its position.
   */
  const start = (editor: Editor, name: string): number => {
    let at = -1;
    editor.prosemirrorView.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === name) at = pos;
      return at < 0;
    });
    return at;
  };
  const HTTP = 'http://e.example/a.png';

  it.each([
    ['in a block, on a picture', (): Record<string, string> => ({ 'text/html': `<p><img src="${HTTP}"></p>`, 'text/plain': '' }), (editor: Editor): number => start(editor, 'image')],
    ['in a figure, on a picture', (): Record<string, string> => ({ 'text/html': `<figure><img src="${HTTP}"></figure>`, 'text/plain': '' }), (editor: Editor): number => start(editor, 'image')],
    [
      'copied from a body, between two blocks',
      (editor: Editor): Record<string, string> => {
        const html = editor.blocksToFullHTML([{ type: 'image', props: { url: HTTP } }] as never);
        return { 'blocknote/html': html, 'text/html': html, 'text/plain': '' };
      },
      (editor: Editor): number => positionOf(editor, 'abcd', 4) + 2,
    ],
  ])('%s: changes nothing in the body or the caret, and is told', async (_name, formats, at) => {
    const { editor, sink } = await openReady([{ type: 'paragraph', content: 'abcd' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    dropFormats(editor, at(editor), formats(editor));
    await settled();
    expect({ lines: lines(editor), selected: selected(editor) }).toEqual({
      lines: ['paragraph:abcd', `image(${PIC})`, 'paragraph:tail'],
      selected: 'caret:abcd@4',
    });
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });
});

describe('a drop carrying neither words nor HTML', () => {
  it('on a code block changes nothing in the body or the caret', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'codeBlock', content: 'x = 1' }]);
    select(editor, positionOf(editor, 'lead', 2));
    dropFormats(editor, positionOf(editor, 'x = 1', 2), { 'text/uri-list': 'https://a.example/' });
    await settled();
    expect({ lines: lines(editor), selected: selected(editor) }).toEqual({ lines: ['paragraph:lead', 'codeBlock:x = 1'], selected: 'caret:lead@2' });
  });
});

describe('a paste with nothing that can land', () => {
  it.each([
    ['a picture alone', (): Record<string, string> => ({ 'text/html': '<img src="http://e.example/a.png">', 'text/plain': '' })],
    ['a picture in a block', (): Record<string, string> => ({ 'text/html': '<p><img src="http://e.example/a.png"></p>', 'text/plain': '' })],
    [
      'a picture copied from a body',
      (editor: Editor): Record<string, string> => {
        const html = editor.blocksToFullHTML([{ type: 'image', props: { url: 'http://e.example/a.png' } }] as never);
        return { 'blocknote/html': html, 'text/html': html, 'text/plain': '' };
      },
    ],
  ])('%s: keeps the selected words, and is told', async (_name, formats) => {
    const { editor, sink } = await openReady([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', 3));
    pasteFormats(editor, formats(editor));
    await settled();
    expect({ lines: lines(editor), selected: selected(editor) }).toEqual({ lines: ['paragraph:abcd'], selected: 'text:bc' });
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });
});

describe('the formats a drop reads, as a paste reads them', () => {
  it('plain text is read as Markdown', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 4, { 'text/plain': '# Title' });
    await settled();
    expect(lines(editor)).toContain('heading:Title');
  });

  it('code from an editor is one code block, its "<" kept', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 4, {
      'text/plain': 'if (a < b) {}',
      'vscode-editor-data': JSON.stringify({ mode: 'typescript' }),
    });
    await settled();
    expect(lines(editor)).toContain('codeBlock:if (a < b) {}');
  });

  it('content of another body lands as it was', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    const html = editor.blocksToFullHTML([{ type: 'heading', content: 'H', props: { level: 2 } }, { type: 'image', props: { url: PIC } }] as never);
    dropFormats(editor, positionOf(editor, 'lead', 4) + 4, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'H' });
    await settled();
    expect(lines(editor).slice(1, 3)).toEqual(['heading:H', `image(${PIC})`]);
  });
});

describe('a drop between two blocks', () => {
  it('lands there, leaving no empty line', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
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
    const { editor } = await openReady([{ type: 'codeBlock', content: 'x' }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, caretIn(editor, 0), formats);
    await settled();
    expect(lines(editor)).toEqual([code, 'paragraph:tail']);
  });
});

describe('a drop into a table cell, what it selects', () => {
  it('a picture alone: selects that picture inside the cell', async () => {
    const { editor } = await openReady([TABLE, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'cell', 2), { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect(selected(editor)).toBe('node:image');
  });

  it('rejects a table mixed with a picture and retains the current selection', async () => {
    const { editor, manager, sink } = await openReady([TWO_CELLS, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'c1', 2));
    const before = editor.prosemirrorView.state;
    dropFormats(editor, positionOf(editor, 'c1', 2), { 'text/html': `<table><tr><td>x</td><td>y</td></tr></table><img src="${PIC}">`, 'text/plain': 'x y' });
    await settled();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before.doc.toJSON());
    expect(editor.prosemirrorView.state.selection.toJSON()).toEqual(before.selection.toJSON());
    expect(manager.undoStack).toHaveLength(0);
    expect(sink.start).not.toHaveBeenCalled();
  });
});

describe('a drop that puts nothing in', () => {
  it('leaves the next edit its own undo step, back to its own caret', async () => {
    const { editor, manager } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
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
    const { editor } = await openReady([
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

describe('a drag within the body into a table cell (design §5.4.7, A14)', () => {
  /**
   * Drags the selection between two words to a point, as ProseMirror's own
   * text drag does.
   * @param editor - The editor.
   * @param from - Where the selection starts.
   * @param to - Where it ends.
   * @param at - Where it is dropped.
   */
  function dragWithin(editor: Editor, from: number, to: number, at: number): void {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: true };
    dropFormats(editor, at, { 'text/html': '<p>x</p>' });
  }

  it('refuses content holding a table, leaving the body as it was', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }] }),
    ]);
    const before = editor.prosemirrorView.state.doc.toJSON();
    dragWithin(editor, positionOf(editor, 'lead', 2), positionOf(editor, 'tail', 2), positionOf(editor, 'c1', 1));
    await settled();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('moves words into the cell as before', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, tableBlock({ rows: [{ cells: ['c1', 'c2'] }] })]);
    dragWithin(editor, positionOf(editor, 'lead', 1), positionOf(editor, 'lead', 3), positionOf(editor, 'c1', 1));
    await settled();
    expect(editor.prosemirrorView.state.doc.textContent).toBe('ldcea1c2');
    expect(warn).not.toHaveBeenCalled();
  });
});
