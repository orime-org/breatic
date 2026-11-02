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
import { cellAround, CellSelection } from '@tiptap/pm/tables';

import { toast } from '@web/lib/toast';
import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';
import { tableClipped } from '@web/spaces/document/document-table-copy';
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
 * @param copyKey - Whether the platform's copy key is held at the drop.
 */
function dropFormats(editor: Editor, at: number, formats: Readonly<Record<string, string>>, clientX = 1, copyKey = false): void {
  const view = editor.prosemirrorView;
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, clientY: 1, altKey: copyKey, ctrlKey: copyKey });
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

  it('words then a picture at the end of a line with nested lines: the joined words, never the nested lines', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'aaa', children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'aaa', 3), { 'text/html': `<p>n</p><img src="${PIC}">`, 'text/plain': 'n' });
    await settled();
    expect(selectedContent(editor)).toEqual({ oneCell: true, words: 'n', media: [] });
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.deleteSelection());
    expect(view.state.doc.textContent).toBe('aaakidtail');
  });

  it('words, a picture and words at the end of a line with nested lines: the joined words alone, the rest after the nested lines', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'aaa', children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'tail' }]);
    dropFormats(editor, positionOf(editor, 'aaa', 3), { 'text/html': `<p>n</p><img src="${PIC}"><p>m</p>`, 'text/plain': 'n m' });
    await settled();
    expect(selectedContent(editor)).toEqual({ oneCell: true, words: 'n', media: [] });
    expect(editor.prosemirrorView.state.doc.textContent).toBe('aaankidmtail');
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
    ['web content of words goes in as its plain text', { 'text/html': '<p>hello</p><p>world</p>', 'text/plain': 'hello\n\nworld' }, 'codeBlock:xhello\n\nworld'],
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
   * @param keys - As {@link dragSelection} takes them.
   * @param keys.started - Whether the drag started as a move.
   * @param keys.copyKey - Whether the copy key is held at the drop.
   * @param keys.collapsed - Whether the selection is collapsed to the drop point before the drop.
   */
  function dragWithin(editor: Editor, from: number, to: number, at: number, keys = { started: true, copyKey: false, collapsed: false }): void {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    dragSelection(editor, at, keys);
  }

  /**
   * Drags the current selection to a point.
   * @param editor - The editor.
   * @param at - Where it is dropped.
   * @param keys - Whether the drag started as a move, whether the copy key is held at the drop, and whether the selection was collapsed to the drop point before it, as Safari does while hovering.
   * @param keys.started - Whether the drag started as a move.
   * @param keys.copyKey - Whether the copy key is held at the drop.
   * @param keys.collapsed - Whether the selection is collapsed to the drop point before the drop.
   */
  function dragSelection(editor: Editor, at: number, keys = { started: true, copyKey: false, collapsed: false }): void {
    const view = editor.prosemirrorView;
    view.focus();
    (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: keys.started };
    if (keys.collapsed) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    dropFormats(editor, at, { 'text/html': '<p>x</p>' }, 1, keys.copyKey);
  }

  /**
   * Puts a comment on words.
   * @param editor - The editor.
   * @param words - The words, as they stand in one line.
   * @param threadId - The comment's thread.
   */
  function comment(editor: Editor, words: string, threadId: string): void {
    const view = editor.prosemirrorView;
    const from = positionOf(editor, words, 0);
    view.dispatch(view.state.tr.addMark(from, from + words.length, view.state.schema.marks[COMMENT_MARK]!.create({ threadId, orphan: false })));
  }

  /**
   * Every run of words carrying a comment, with its thread.
   * @param editor - The editor.
   * @returns `words:thread`.
   */
  function commented(editor: Editor): string[] {
    const found: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      const mark = node.isText ? node.marks.find((m) => m.type.name === COMMENT_MARK) : undefined;
      if (mark !== undefined) found.push(`${node.text}:${String(mark.attrs['threadId'])}`);
      return true;
    });
    return found;
  }

  /**
   * Every table's cells, in order, and the names of the tables.
   * @param editor - The editor.
   * @returns Each table's type and its cells' words.
   */
  function grids(editor: Editor): string[] {
    const found: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name !== 'docTable' && node.type.name !== 'table') return true;
      const cells: string[] = [];
      node.descendants((cell) => {
        if (cell.type.name !== 'docTableCell' && cell.type.name !== 'tableCell') return true;
        cells.push(cell.textContent);
        return false;
      });
      found.push(`${node.type.name}:${cells.join(',')}`);
      return false;
    });
    return found;
  }

  it('fills cells from the drop with a stored table alone, as its paste does, never nesting it', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } },
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ] as unknown as Parameters<typeof open>[0]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1));
    await settled();
    expect(grids(editor)).toEqual(['docTable:c1,c2,l1,l2']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a stored table with other content, leaving the body as it was', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } },
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }] }),
    ] as unknown as Parameters<typeof open>[0]);
    const before = editor.prosemirrorView.state.doc.toJSON();
    dragWithin(editor, positionOf(editor, 'lead', 2), positionOf(editor, 'tail', 2), positionOf(editor, 'c1', 1));
    await settled();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('copies a table when the copy key is held at the drop, though the drag started as a move', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1), { started: true, copyKey: true, collapsed: false });
    await settled();
    expect(grids(editor)).toEqual(['docTable:t1,t2', 'docTable:c1,c2,t1,t2']);
  });

  it('moves a table when the copy key is let go before the drop, though the drag started as a copy', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1), { started: false, copyKey: false, collapsed: false });
    await settled();
    expect(grids(editor)).toEqual(['docTable:c1,c2,t1,t2']);
  });

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

  it('fills cells from the drop with one table alone, as its paste does, and takes it from where it was', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1));
    await settled();
    const grids: string[][] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name !== 'docTable') return true;
      const rows: string[] = [];
      node.forEach((row) => row.forEach((cell) => rows.push(cell.textContent)));
      grids.push(rows);
      return false;
    });
    expect(grids).toEqual([['c1', 'c2', 't1', 't2']]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills cells from the drag\'s own content when the selection has moved to the drop point, as Safari moves it while hovering', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1), { started: true, copyKey: false, collapsed: true });
    await settled();
    expect(grids(editor)).toContain('docTable:c1,c2,t1,t2');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the comments of a table it moves into cells, and drops them from a copy', async () => {
    for (const copyKey of [false, true]) {
      const { editor } = await openReady([
        { type: 'paragraph', content: 'lead' },
        tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
        { type: 'paragraph', content: 'tail' },
        tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
      ]);
      comment(editor, 't1', 'th1');
      dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1), { started: true, copyKey, collapsed: false });
      await settled();
      expect(grids(editor).at(-1)).toBe('docTable:c1,c2,t1,t2');
      expect(commented(editor)).toEqual(['t1:th1']);
      unmountAll();
    }
  });

  it('fills cells from the drop with cells selected in another table, each row as wide as before', async () => {
    const { editor } = await openReady([
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
      { type: 'paragraph', content: 'mid' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ]);
    const view = editor.prosemirrorView;
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'docTableCell') cells.push(pos);
      return true;
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[1]!)));
    dragSelection(editor, positionOf(editor, 'c3', 1));
    await settled();
    expect(grids(editor)).toEqual(['docTable:,,a2,b2', 'docTable:c1,c2,a1,b1']);
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

describe('a drag within the body into a block that takes only words (design §5.4.1, A7)', () => {
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
    view.focus();
    (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: true };
    dropFormats(editor, at, { 'text/html': '<p>x</p>' });
  }

  it('puts two lines into a code block as its words, the code block kept whole', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      { type: 'paragraph', content: 'tail' },
      { type: 'codeBlock', content: 'const x = 1;' },
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 2), positionOf(editor, 'tail', 2), positionOf(editor, 'const x = 1;', 5));
    await settled();
    expect(lines(editor)).toEqual(['paragraph:leil', 'codeBlock:constad\nta x = 1;']);
  });

  it('puts content holding a table into a stored table\'s cell as its words, the stored table kept whole', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['t1', 't2'] }] }),
      { type: 'paragraph', content: 'tail' },
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } },
    ] as unknown as Parameters<typeof open>[0]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'l1', 1));
    await settled();
    const stored: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name === 'table') stored.push(node.textContent);
      return node.type.name !== 'table';
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('t1');
    expect(lines(editor).filter((label) => label === 'table')).toHaveLength(1);
  });
});

describe('a drag within the body, put as its paste at the drop point (design §5.4.1)', () => {
  /**
   * Drags the selection between two points to a third.
   * @param editor - The editor.
   * @param from - Where the selection starts.
   * @param to - Where it ends.
   * @param at - Where it is dropped.
   * @param collapsed - Whether the selection is collapsed to the drop point before the drop, as Safari does while hovering.
   */
  function dragWithin(editor: Editor, from: number, to: number, at: number, collapsed = false): void {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    view.focus();
    // A drag from this body starts with a dragstart in it, which BlockNote's
    // `UniqueID` reads to keep the row ids a move carries.
    view.dom.parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: true };
    if (collapsed) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    dropFormats(editor, at, { 'text/html': '<p>x</p>' });
  }

  /**
   * How many row ids appear more than once.
   * @param editor - The editor.
   * @returns The count.
   */
  function repeatedIds(editor: Editor): number {
    const ids: unknown[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name === 'blockContainer') ids.push(node.attrs['id']);
      return true;
    });
    return ids.length - new Set(ids).size;
  }

  /**
   * Every run of words carrying a comment.
   * @param editor - The editor.
   * @returns The words.
   */
  function commentedWords(editor: Editor): string[] {
    const found: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === COMMENT_MARK)) found.push(node.text!);
      return true;
    });
    return found;
  }

  /**
   * Where the first empty plain line's words would start.
   * @param editor - The editor.
   * @returns The position.
   */
  function emptyLine(editor: Editor): number {
    let at = -1;
    editor.prosemirrorView.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'paragraph' && node.content.size === 0) at = pos + 1;
      return at < 0;
    });
    return at;
  }

  it('gives a line left partly behind its own row id, never to the words moved out of it', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }, { type: 'paragraph', content: 'efgh' }, { type: 'paragraph', content: 'tail' }]);
    dragWithin(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'efgh', 2), positionOf(editor, 'tail', 4));
    await settled();
    expect(repeatedIds(editor)).toBe(0);
  });

  it('gives no row id twice when lines around a picture are moved into an empty line', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'abcd' },
      { type: 'image', props: { url: PIC } },
      { type: 'paragraph', content: 'tail' },
      { type: 'paragraph' },
      { type: 'paragraph', content: 'end' },
    ]);
    dragWithin(editor, positionOf(editor, 'abcd', 2), positionOf(editor, 'tail', 2), emptyLine(editor));
    await settled();
    expect(repeatedIds(editor)).toBe(0);
  });

  it('lands as a copy when nothing was taken from where the drag began', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'aa' }, { type: 'paragraph', content: 'bb' }, { type: 'paragraph', content: 'cc' }, { type: 'paragraph', content: 'tail' }]);
    const view = editor.prosemirrorView;
    const from = positionOf(editor, 'bb', 0);
    view.dispatch(view.state.tr.addMark(from, from + 2, view.state.schema.marks[COMMENT_MARK]!.create({ threadId: 'th1', orphan: false })));
    dragWithin(editor, positionOf(editor, 'aa', 2), positionOf(editor, 'cc', 2), positionOf(editor, 'tail', 4), true);
    await settled();
    expect(repeatedIds(editor)).toBe(0);
    expect(commentedWords(editor)).toEqual(['bb']);
  });

  it('fills cells from the drop with a table whose cells are empty', async () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('w');
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      tableBlock({ rows: [{ cells: ['', ''] }] }),
      { type: 'paragraph', content: 'tail' },
      tableBlock({ rows: [{ cells: ['c1', 'c2'] }, { cells: ['c3', 'c4'] }] }),
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), positionOf(editor, 'c3', 1));
    await settled();
    expect(lines(editor)).toEqual(['paragraph:leadtail', 'table']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a lone line break it moves', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }, { type: 'paragraph', content: 'tail' }]);
    const view = editor.prosemirrorView;
    const at = positionOf(editor, 'abcd', 2);
    view.dispatch(view.state.tr.insert(at, view.state.schema.nodes['hardBreak']!.create()));
    dragWithin(editor, at, at + 1, positionOf(editor, 'tail', 2));
    await settled();
    let breaks = 0;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') breaks += 1;
      return true;
    });
    expect(breaks).toBe(1);
  });

  it('puts a picture selected from one line\'s end to the next line\'s start as that picture alone', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      { type: 'image', props: { url: PIC } },
      { type: 'paragraph', content: 'tail' },
      { type: 'paragraph', content: 'mid' },
      { type: 'paragraph' },
      { type: 'paragraph', content: 'end' },
    ]);
    dragWithin(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0), emptyLine(editor));
    await settled();
    expect(lines(editor)).toEqual(['paragraph:leadtail', 'paragraph:mid', `image(${PIC})`, 'paragraph:', 'paragraph:end']);
  });

  /**
   * The body's own copy of a range, as the clipboard carries it.
   * @param editor - The editor.
   * @param from - Where the range starts.
   * @param to - Where it ends.
   * @returns The clipboard HTML.
   */
  function copyOf(editor: Editor, from: number, to: number): string {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    return view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
  }

  /**
   * Pastes clipboard formats with the caret at a point.
   * @param editor - The editor.
   * @param at - The caret.
   * @param formats - The clipboard.
   */
  function pasteAtPoint(editor: Editor, at: number, formats: Readonly<Record<string, string>>): void {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    view.focus();
    pasteFormats(editor, formats);
  }

  /**
   * The code blocks' words.
   * @param editor - The editor.
   * @returns Each code block's text.
   */
  function codeWords(editor: Editor): string[] {
    const found: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') found.push(node.textContent);
      return true;
    });
    return found;
  }

  it('pastes a picture framed from one line\'s end to the next line\'s start into a code block without touching its code', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'tail' }, { type: 'codeBlock', content: 'xy' }]);
    const html = copyOf(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0));
    pasteAtPoint(editor, positionOf(editor, 'xy', 1), { 'blocknote/html': html, 'text/html': html, 'text/plain': '' });
    await settled();
    expect(codeWords(editor)).toEqual(['xy']);
    expect(lines(editor).filter((label) => label === `image(${PIC})`)).toHaveLength(2);
  });

  it('pastes words copied from one line\'s end into an empty line as that line', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'foo' }, { type: 'paragraph', content: 'bar' }, { type: 'paragraph' }, { type: 'paragraph', content: 'abcd' }]);
    const html = copyOf(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'foo', 3));
    pasteAtPoint(editor, emptyLine(editor), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'foo' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', 'paragraph:foo', 'paragraph:bar', 'paragraph:foo', 'paragraph:abcd']);
  });

  it('pastes two line breaks copied together as at least one', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }, { type: 'paragraph', content: 'tail' }]);
    const view = editor.prosemirrorView;
    const at = positionOf(editor, 'abcd', 2);
    view.dispatch(view.state.tr.insert(at, [view.state.schema.nodes['hardBreak']!.create(), view.state.schema.nodes['hardBreak']!.create()]));
    const html = copyOf(editor, at, at + 2);
    pasteAtPoint(editor, positionOf(editor, 'tail', 2), { 'blocknote/html': html, 'text/html': html, 'text/plain': '\n\n' });
    await settled();
    let breaks = 0;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') breaks += 1;
      return true;
    });
    expect(breaks).toBeGreaterThan(2);
  });

  it('changes nothing for a drag of line breaks alone into a code block', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'aa' }, { type: 'paragraph', content: 'bb' }, { type: 'codeBlock', content: 'const x' }]);
    const before = editor.prosemirrorView.state.doc.toJSON();
    dragWithin(editor, positionOf(editor, 'aa', 2), positionOf(editor, 'bb', 0), positionOf(editor, 'const x', 5));
    await settled();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before);
  });

  it('pastes a framed picture at a line\'s end with no empty line after it', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'tail' }, { type: 'paragraph', content: 'mid' }, { type: 'paragraph', content: 'end' }]);
    const html = copyOf(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0));
    pasteAtPoint(editor, positionOf(editor, 'mid', 3), { 'blocknote/html': html, 'text/html': html, 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `image(${PIC})`, 'paragraph:tail', 'paragraph:mid', `image(${PIC})`, 'paragraph:end']);
  });

  it('changes nothing when selected cells are dropped onto one of themselves', async () => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }, { cells: ['a3', 'b3'] }] })]);
    const view = editor.prosemirrorView;
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'docTableCell') cells.push(pos);
      return true;
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[4]!)));
    const before = view.state.doc.toJSON();
    view.focus();
    view.dom.parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: true };
    dropFormats(editor, positionOf(editor, 'a2', 1), { 'text/html': '<p>x</p>' });
    await settled();
    expect(view.state.doc.toJSON()).toEqual(before);
  });

  it('pastes a picture framed from a nested item\'s end with no empty item', async () => {
    const { editor } = await openReady([
      { type: 'bulletListItem', content: 'par', children: [{ type: 'bulletListItem', content: 'kid' }] },
      { type: 'image', props: { url: PIC } },
      { type: 'paragraph', content: 'tail' },
      { type: 'paragraph' },
      { type: 'paragraph', content: 'end' },
    ]);
    const html = copyOf(editor, positionOf(editor, 'kid', 3), positionOf(editor, 'tail', 0));
    pasteAtPoint(editor, emptyLine(editor), { 'blocknote/html': html, 'text/html': html, 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['bulletListItem:par', `image(${PIC})`, 'paragraph:tail', `image(${PIC})`, 'paragraph:', 'paragraph:end']);
  });

  it('pastes web content with no media into a code block as its plain text', async () => {
    const { editor } = await openReady([{ type: 'codeBlock', content: 'code' }]);
    pasteAtPoint(editor, positionOf(editor, 'code', 4), { 'text/html': '<h1>Title</h1><p>para</p><ul><li>x</li><li>y</li></ul>', 'text/plain': 'Title\n\npara\n\n- x\n- y' });
    await settled();
    expect(codeWords(editor)).toEqual(['codeTitle\n\npara\n\n- x\n- y']);
  });

  /**
   * The blocks with their nested blocks, as labels.
   * @param editor - The editor.
   * @returns `type:words[nested]` per top-level block.
   */
  function tree(editor: Editor): string[] {
    const label = (block: Block): string => {
      const words = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '';
      const nested = (block.children ?? []).map(label);
      return `${block.type}:${words}${nested.length > 0 ? `[${nested.join(',')}]` : ''}`;
    };
    return (editor.document as Block[]).map(label);
  }

  /**
   * Copies a range of a fresh document and pastes it at a point of the same document.
   * @param blocks - The document.
   * @param from - Where the copy starts: a line's words and an offset in them.
   * @param to - Where it ends.
   * @param at - Where it is pasted.
   * @returns The blocks after the paste.
   */
  async function copyPaste(blocks: unknown[], from: [string, number], to: [string, number], at: [string, number]): Promise<string[]> {
    const { editor } = await openReady(blocks as Parameters<typeof open>[0]);
    const html = copyOf(editor, positionOf(editor, from[0], from[1]), positionOf(editor, to[0], to[1]));
    pasteAtPoint(editor, positionOf(editor, at[0], at[1]), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'x' });
    await settled();
    const out = tree(editor);
    unmountAll();
    return out;
  }

  const item = (words: string, children: unknown[] = []): unknown => ({ type: 'bulletListItem', content: words, children });
  const para = (words: string): unknown => ({ type: 'paragraph', content: words });

  it('pastes one item copied to its nested item\'s start as that item alone, never nesting the line it lands in', async () => {
    const doc = [item('par', [item('kid')]), para('next'), para('abcd')];
    const kept = ['bulletListItem:par[bulletListItem:kid]', 'paragraph:next'];
    expect(await copyPaste(doc, ['par', 0], ['kid', 0], ['abcd', 2])).toEqual([...kept, 'paragraph:abpar', 'paragraph:cd']);
    expect(await copyPaste(doc, ['par', 0], ['kid', 0], ['abcd', 4])).toEqual([...kept, 'paragraph:abcdpar']);
    expect(await copyPaste(doc, ['par', 0], ['kid', 0], ['abcd', 0])).toEqual([...kept, 'bulletListItem:par', 'paragraph:abcd']);
  });

  it('pastes lines copied to a nested item\'s start with their last line kept whole, as the same lines at the top level', async () => {
    const doc = [para('lead'), item('par', [item('kid')]), para('abcd')];
    const kept = ['paragraph:lead', 'bulletListItem:par[bulletListItem:kid]'];
    expect(await copyPaste(doc, ['lead', 0], ['kid', 0], ['abcd', 2])).toEqual([...kept, 'paragraph:ablead', 'bulletListItem:par', 'paragraph:cd']);
    expect(await copyPaste(doc, ['lead', 0], ['kid', 0], ['abcd', 0])).toEqual([...kept, 'paragraph:lead', 'bulletListItem:par', 'paragraph:abcd']);
  });

  it('joins words copied into a nested item\'s words with the line they land in, with media among them too', async () => {
    const doc = [para('lead'), item('par', [item('kid')]), para('abcd')];
    const kept = ['paragraph:lead', 'bulletListItem:par[bulletListItem:kid]'];
    expect(await copyPaste(doc, ['lead', 2], ['kid', 2], ['abcd', 2])).toEqual([...kept, 'paragraph:abad', 'bulletListItem:par', 'paragraph:kicd']);
    expect(await copyPaste(doc, ['lead', 2], ['kid', 2], ['abcd', 0])).toEqual([...kept, 'paragraph:ad', 'bulletListItem:par', 'paragraph:kiabcd']);
    const mixed = [para('lead'), { type: 'image', props: { url: PIC } }, item('par', [item('kid')]), para('abcd')];
    expect(await copyPaste(mixed, ['lead', 2], ['kid', 2], ['abcd', 2])).toEqual(['paragraph:lead', 'image:', 'bulletListItem:par[bulletListItem:kid]', 'paragraph:abad', 'image:', 'bulletListItem:par', 'paragraph:kicd']);
  });

  it('joins words copied from a nested item\'s middle with the line they land in', async () => {
    const doc = [item('p1', [item('k1k1')]), item('p2', [item('k2k2')]), para('xxyy')];
    expect((await copyPaste(doc, ['k1k1', 2], ['k2k2', 2], ['xxyy', 2])).slice(2)).toEqual(['paragraph:xxk1', 'bulletListItem:p2', 'paragraph:k2yy']);
  });

  it('pastes a copy whose end is an empty code block with no empty code block', async () => {
    const lines = [para('lead'), para('foo'), { type: 'codeBlock', content: 'code' }, para('abcd')];
    expect((await copyPaste(lines, ['lead', 4], ['code', 0], ['abcd', 2])).slice(3)).toEqual(['paragraph:ab', 'paragraph:foo', 'paragraph:cd']);
    const code = [{ type: 'codeBlock', content: 'code' }, para('yy'), para('abcd')];
    expect((await copyPaste(code, ['code', 4], ['yy', 2], ['abcd', 2])).slice(2)).toEqual(['paragraph:ab', 'paragraph:yycd']);
    expect((await copyPaste(code, ['code', 4], ['yy', 2], ['abcd', 4])).slice(2)).toEqual(['paragraph:abcd', 'paragraph:yy']);
  });

  it('selects a whole line dragged to a line\'s start without reaching into that line', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'foo' }, { type: 'paragraph', content: 'next' }, { type: 'paragraph', content: 'xy' }]);
    dragWithin(editor, positionOf(editor, 'foo', 0), positionOf(editor, 'next', 0), positionOf(editor, 'xy', 0));
    await settled();
    expect(lines(editor)).toEqual(['paragraph:next', 'paragraph:foo', 'paragraph:xy']);
    expect(selected(editor)).toBe('text:foo');
  });

  /**
   * The position in the n-th empty line of the document.
   * @param editor - The editor.
   * @param n - Which empty line, from 0.
   * @returns The position.
   */
  function nthEmptyLine(editor: Editor, n: number): number {
    let seen = 0;
    let found = -1;
    editor.prosemirrorView.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isTextblock && node.content.size === 0) {
        if (seen === n) found = pos + 1;
        seen += 1;
      }
      return found < 0;
    });
    return found;
  }

  /**
   * Each cell's words, in order.
   * @param editor - The editor.
   * @returns The cells' text, lines joined by a slash.
   */
  function cellWords(editor: Editor): string[] {
    const found: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name !== 'docTableCell') return true;
      const words: string[] = [];
      node.descendants((inner) => {
        if (inner.isTextblock) words.push(inner.textContent);
        return !inner.isTextblock;
      });
      found.push(words.join('/'));
      return false;
    });
    return found;
  }

  it('pastes words copied from a nested item\'s middle to a later line\'s middle as their lines, and drops them alike', async () => {
    const doc = [item('par', [item('kid')]), para('next'), para('xxyy')];
    expect((await copyPaste(doc, ['kid', 1], ['next', 2], ['xxyy', 2])).slice(2)).toEqual(['paragraph:xxid', 'paragraph:neyy']);
    const deep = [item('a', [item('b', [item('cccc')])]), para('next'), para('xxyy')];
    expect((await copyPaste(deep, ['cccc', 2], ['next', 2], ['xxyy', 2])).slice(2)).toEqual(['paragraph:xxcc', 'paragraph:neyy']);
    const { editor } = await openReady(doc as Parameters<typeof open>[0]);
    dragWithin(editor, positionOf(editor, 'kid', 1), positionOf(editor, 'next', 2), positionOf(editor, 'xxyy', 2));
    await settled();
    expect(tree(editor)).toEqual(['bulletListItem:par[bulletListItem:kxt]', 'paragraph:xxid', 'paragraph:neyy']);
  });

  it('keeps the empty lines a copy between nested items holds, as the same copy at the top level does', async () => {
    const nested = [item('par', [item('k1k1'), item(''), item('')]), para('xxyy')];
    const tail = async (at: number): Promise<string[]> => {
      const { editor } = await openReady(nested as Parameters<typeof open>[0]);
      const html = copyOf(editor, positionOf(editor, 'k1k1', 2), nthEmptyLine(editor, 1));
      pasteAtPoint(editor, positionOf(editor, 'xxyy', at), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'x' });
      await settled();
      const out = tree(editor).slice(1);
      unmountAll();
      return out;
    };
    expect(await tail(2)).toEqual(['paragraph:xxk1', 'bulletListItem:', 'paragraph:yy']);
    expect(await tail(4)).toEqual(['paragraph:xxyyk1', 'bulletListItem:']);
    expect(await tail(0)).toEqual(['bulletListItem:k1', 'bulletListItem:', 'paragraph:xxyy']);
    const { editor } = await openReady([para('k1k1'), item('', [item('')]), para('xxyy')] as Parameters<typeof open>[0]);
    const html = copyOf(editor, positionOf(editor, 'k1k1', 2), nthEmptyLine(editor, 1));
    pasteAtPoint(editor, positionOf(editor, 'xxyy', 2), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'x' });
    await settled();
    expect(tree(editor).slice(2)).toEqual(['paragraph:xxk1', 'bulletListItem:', 'paragraph:yy']);
  });

  it('pastes from a nested line\'s end to a sibling\'s words as that line break and those words', async () => {
    const doc = [item('par', [item('k0'), item(''), item('k3k3')]), para('xxyy')];
    expect((await copyPaste(doc, ['k0', 2], ['k3k3', 2], ['xxyy', 0])).slice(1)).toEqual(['bulletListItem:', 'paragraph:k3xxyy']);
    const two = [item('par', [item('k0'), item('k3')]), para('xxyy')];
    expect((await copyPaste(two, ['k0', 2], ['k3', 1], ['xxyy', 2])).slice(1)).toEqual(['paragraph:xx', 'paragraph:kyy']);
  });

  it('pastes from the end of a line with nested lines as those nested lines, no empty line before them', async () => {
    const doc = [item('par', [item('kid', [item('gkid')])]), para('next'), para('xxyy')];
    expect((await copyPaste(doc, ['kid', 3], ['next', 0], ['xxyy', 4])).slice(2)).toEqual(['paragraph:xxyy', 'bulletListItem:gkid']);
  });

  it('drops words dragged out of a cell as their copy pastes there, never as a table', async () => {
    const doc = [tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'paragraph', content: 'aaaa' }, { type: 'paragraph', content: 'bb' }] }, 'zzzz'] }] } as never), para('xyzw')];
    const body = await openReady(doc as Parameters<typeof open>[0]);
    dragWithin(body.editor, positionOf(body.editor, 'aaaa', 1), positionOf(body.editor, 'aaaa', 3), positionOf(body.editor, 'xyzw', 2));
    await settled();
    expect(lines(body.editor)).toEqual(['table', 'paragraph:xyaazw']);
    expect(cellWords(body.editor)).toEqual(['aa/bb', 'zzzz']);
    unmountAll();
    const cell = await openReady(doc as Parameters<typeof open>[0]);
    dragWithin(cell.editor, positionOf(cell.editor, 'aaaa', 1), positionOf(cell.editor, 'aaaa', 3), positionOf(cell.editor, 'zzzz', 2));
    await settled();
    expect(cellWords(cell.editor)).toEqual(['aa/bb', 'zzaazz']);
  });

  it('pastes a whole line copied in a cell as that line, no empty line after it', async () => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'paragraph', content: 'aaaa' }, { type: 'paragraph', content: 'bb' }] }, 'zzzz'] }] } as never), para('xyzw')] as Parameters<typeof open>[0]);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'aaaa', 0), positionOf(editor, 'bb', 0))));
    const html = tableClipped(editor as never, view)!.internal;
    pasteAtPoint(editor, positionOf(editor, 'xyzw', 4), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'aaaa' });
    await settled();
    expect(lines(editor)).toEqual(['table', 'paragraph:xyzwaaaa']);
  });

  it('drops lines dragged to a nested item\'s start as they paste there', async () => {
    const { editor } = await openReady([para('lead'), item('par', [item('kid')]), para('abcd')] as Parameters<typeof open>[0]);
    dragWithin(editor, positionOf(editor, 'lead', 0), positionOf(editor, 'kid', 0), positionOf(editor, 'abcd', 2));
    await settled();
    expect(tree(editor).slice(1)).toEqual(['paragraph:ablead', 'bulletListItem:par', 'paragraph:cd']);
  });

  it('pastes a whole line copied to the next line\'s start into a line\'s end, an empty heading and a line\'s start as their words', async () => {
    const whole = await openReady([{ type: 'paragraph', content: 'hello' }, { type: 'paragraph', content: 'next' }, { type: 'paragraph', content: 'xy' }]);
    const line = copyOf(whole.editor, positionOf(whole.editor, 'hello', 0), positionOf(whole.editor, 'next', 0));
    pasteAtPoint(whole.editor, positionOf(whole.editor, 'xy', 2), { 'blocknote/html': line, 'text/html': line, 'text/plain': 'hello' });
    await settled();
    expect(lines(whole.editor)).toEqual(['paragraph:hello', 'paragraph:next', 'paragraph:xyhello']);
    unmountAll();
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'foo' }, { type: 'heading' }, { type: 'paragraph', content: 'ab' }]);
    const html = copyOf(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'foo', 3));
    let heading = -1;
    editor.prosemirrorView.state.doc.descendants((node, pos) => {
      if (heading < 0 && node.type.name === 'heading') heading = pos + 1;
      return heading < 0;
    });
    pasteAtPoint(editor, heading, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'foo' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', 'paragraph:foo', 'heading:foo', 'paragraph:ab']);
    pasteAtPoint(editor, positionOf(editor, 'ab', 0), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'foo' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', 'paragraph:foo', 'heading:foo', 'paragraph:fooab']);
  });

  it('gives blocks a copy drag puts no row id of the string "null"', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'foo' }, { type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'bar' }, { type: 'paragraph', content: 'xxxx' }]);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'foo', 0), positionOf(editor, 'bar', 3))));
    view.focus();
    view.dom.parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.serializeForClipboard(view.state.selection.content()).slice, move: false };
    dropFormats(editor, positionOf(editor, 'xxxx', 2), { 'text/html': '<p>x</p>' }, 1, true);
    await settled();
    const ids: unknown[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === 'blockContainer') ids.push(node.attrs['id']);
      return true;
    });
    expect(ids.filter((id) => id === 'null' || id === null)).toEqual([]);
  });

  it('pastes words copied from one line\'s end into a stored table\'s cell with no line break', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'Head' }, { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['l1', 'l2'] }] } }] as unknown as Parameters<typeof open>[0]);
    const html = copyOf(editor, positionOf(editor, 'lead', 4), positionOf(editor, 'Head', 4));
    pasteAtPoint(editor, positionOf(editor, 'l1', 1), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'Head' });
    await settled();
    let breaks = 0;
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') breaks += 1;
      return true;
    });
    expect(breaks).toBe(0);
  });

  it('pastes words copied from a nested item\'s end into a line\'s middle with no empty item', async () => {
    const { editor } = await openReady([{ type: 'bulletListItem', content: 'par', children: [{ type: 'bulletListItem', content: 'kid' }] }, { type: 'paragraph', content: 'xx' }, { type: 'paragraph', content: 'abcd' }]);
    const html = copyOf(editor, positionOf(editor, 'kid', 3), positionOf(editor, 'xx', 2));
    pasteAtPoint(editor, positionOf(editor, 'abcd', 2), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'xx' });
    await settled();
    expect(lines(editor)).toEqual(['bulletListItem:par', 'paragraph:xx', 'paragraph:ab', 'paragraph:xxcd']);
  });

  it('pastes lines copied to a nested item\'s start with no empty nested item', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'bulletListItem', content: 'par', children: [{ type: 'bulletListItem', content: 'kid' }] }, { type: 'paragraph', content: 'abcd' }]);
    const html = copyOf(editor, positionOf(editor, 'lead', 0), positionOf(editor, 'kid', 0));
    pasteAtPoint(editor, positionOf(editor, 'abcd', 4), { 'blocknote/html': html, 'text/html': html, 'text/plain': 'lead' });
    await settled();
    const last = (editor.document as { type: string; children: unknown[] }[]).at(-1)!;
    expect(last.type).toBe('bulletListItem');
    expect(last.children).toEqual([]);
  });

  it('fills cells from a code block in a cell with a web table, as A12 fills them', async () => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'codeBlock', content: 'code' }] }, 'n'] }] } as never)]);
    pasteAtPoint(editor, positionOf(editor, 'code', 2), { 'text/html': '<table><tr><td>s1</td><td>s2</td></tr></table>', 'text/plain': 's1\ts2' });
    await settled();
    expect(codeWords(editor)).not.toContain('cos1\ts2de');
  });

  it('pastes a picture copied from one line\'s end to the next line\'s start as that picture alone', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'lead' },
      { type: 'image', props: { url: PIC } },
      { type: 'paragraph', content: 'tail' },
      { type: 'paragraph', content: 'mid' },
      { type: 'paragraph' },
      { type: 'paragraph', content: 'end' },
    ]);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'lead', 4), positionOf(editor, 'tail', 0))));
    const html = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, emptyLine(editor))));
    view.focus();
    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `image(${PIC})`, 'paragraph:tail', 'paragraph:mid', `image(${PIC})`, 'paragraph:', 'paragraph:end']);
  });

  it('puts words into an empty heading as that heading\'s words', async () => {
    const { editor } = await openReady([{ type: 'heading' }, { type: 'paragraph', content: 'abcd' }]);
    const view = editor.prosemirrorView;
    let heading = -1;
    view.state.doc.descendants((node, pos) => {
      if (heading < 0 && node.type.name === 'heading') heading = pos + 1;
      return heading < 0;
    });
    dragWithin(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', 3), heading);
    await settled();
    expect(lines(editor)).toEqual(['heading:bc', 'paragraph:ad']);
  });

  it('moves whole lines with their comments and their row ids', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'aa' },
      { type: 'paragraph', content: 'bb' },
      { type: 'paragraph', content: 'cc' },
      { type: 'paragraph', content: 'tail' },
    ]);
    const view = editor.prosemirrorView;
    const from = positionOf(editor, 'bb', 0);
    view.dispatch(view.state.tr.addMark(from, from + 2, view.state.schema.marks[COMMENT_MARK]!.create({ threadId: 'th1', orphan: false })));
    const ids = (editor.document as { id: string; content: { text?: string }[] }[]).map((block) => `${block.content.map((c) => c.text ?? '').join('')}:${block.id}`);
    dragWithin(editor, positionOf(editor, 'aa', 2), positionOf(editor, 'cc', 2), positionOf(editor, 'tail', 4));
    await settled();
    expect(lines(editor)).toEqual(['paragraph:aa', 'paragraph:tail', 'paragraph:bb', 'paragraph:cc']);
    const after = (editor.document as { id: string; content: { text?: string }[] }[]).map((block) => `${block.content.map((c) => c.text ?? '').join('')}:${block.id}`);
    expect(after).toContain(ids[1]);
    const marked: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === COMMENT_MARK)) marked.push(node.text!);
      return true;
    });
    expect(marked).toEqual(['bb']);
  });

  it('moves lines around a picture with their comments and their row ids', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'aa' },
      { type: 'paragraph', content: 'bb' },
      { type: 'image', props: { url: PIC } },
      { type: 'paragraph', content: 'cc' },
      { type: 'paragraph', content: 'tail' },
    ]);
    const view = editor.prosemirrorView;
    const from = positionOf(editor, 'bb', 0);
    view.dispatch(view.state.tr.addMark(from, from + 2, view.state.schema.marks[COMMENT_MARK]!.create({ threadId: 'th1', orphan: false })));
    const bbId = (editor.document as { id: string; content?: { text?: string }[] }[]).find((block) => block.content?.[0]?.text === 'bb')!.id;
    dragWithin(editor, positionOf(editor, 'aa', 2), positionOf(editor, 'cc', 2), positionOf(editor, 'tail', 4));
    await settled();
    expect(lines(editor)).toEqual(['paragraph:aa', 'paragraph:tail', 'paragraph:bb', `image(${PIC})`, 'paragraph:cc']);
    expect((editor.document as { id: string; content?: { text?: string }[] }[]).find((block) => block.content?.[0]?.text === 'bb')!.id).toBe(bbId);
    const marked: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === COMMENT_MARK)) marked.push(node.text!);
      return true;
    });
    expect(marked).toEqual(['bb']);
  });

  it('changes nothing when dropped onto the dragged content itself', async () => {
    const { editor } = await openReady([{ type: 'paragraph', content: 'abcd' }, { type: 'paragraph', content: 'tail' }]);
    const before = editor.prosemirrorView.state.doc.toJSON();
    dragWithin(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'tail', 2), positionOf(editor, 'abcd', 3));
    await settled();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before);
  });
});
