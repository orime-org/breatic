// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Web content with media, pasted or dropped the way a reader does it
 * (inner#1351 + inner#1390 design §5.1, §5.4; A5, A7, A12–A14): HTML carrying
 * media is read as HTML even when its plain text looks like Markdown;
 * ordinary media stay in their table cells, mixed table content is rejected
 * in a cell, and a drop of web content is judged as a paste is.
 */

import { act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CellSelection } from '@tiptap/pm/tables';

import { toast } from '@web/lib/toast';

import {
  OURS,
  TABLE,
  TWO_CELLS,
  blockOrder,
  caretIn,
  drop,
  firstCell,
  open,
  paste,
  select,
  settled,
  shape,
  type,
  unmountAll,
  type Editor,
  type Sink,
} from './paste-harness';

beforeEach(() => {
  vi.spyOn(toast, 'warning').mockReturnValue('html-media-warning');
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

/** A table layout block or an ordinary block held in a cell. */
type Block = {
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
  children?: Block[];
};

/**
 * Opens a body and lets fixture DOM updates settle before a user selection.
 * @param blocks - The initial body.
 * @returns The mounted body, undo manager and upload sink.
 */
async function openReady(blocks: Parameters<typeof open>[0]): Promise<ReturnType<typeof open>> {
  const opened = open(blocks);
  await act(async () => { await settled(); });
  return opened;
}

/**
 * Reads the ordinary blocks in one new-table cell.
 * @param editor - The editor.
 * @param table - The top-level table index.
 * @param row - The row index.
 * @param column - The cell index.
 * @returns The cell's direct blocks.
 */
function cellBlocks(editor: Editor, table = 0, row = 0, column = 0): Block[] {
  return (editor.document as Block[])[table]!.children![row]!.children![column]!.children!;
}

/**
 * Labels the ordinary blocks in one cell without moving media outside it.
 * @param editor - The editor.
 * @param table - The top-level table index.
 * @param row - The row index.
 * @param column - The cell index.
 * @returns Block types, words, media status and captions in cell order.
 */
function cellShape(editor: Editor, table = 0, row = 0, column = 0): string[] {
  return cellBlocks(editor, table, row, column).map((block) => ['image', 'video', 'audio'].includes(block.type)
    ? `${block.type}[${block.props['uploadId'] !== '' ? 'pending' : String(block.props['url'])}|${String(block.props['caption'])}]`
    : `${block.type}:${(block.content ?? []).map((part) => part.text ?? '').join('')}`);
}

/**
 * Pastes unsupported mixed content and checks that rejection has no side effects.
 * @param html - The original clipboard HTML.
 * @param text - Its original plain text.
 * @param blocks - The unchanged target fixture.
 */
async function rejectInCell(html: string, text: string, blocks: Parameters<typeof open>[0] = [TABLE]): Promise<void> {
  const { editor, sink, manager } = await openReady(blocks);
  caretIn(editor, 0);
  const before = editor.prosemirrorView.state;
  const undo = manager.undoStack.slice();
  const redo = manager.redoStack.slice();
  const warnings = vi.mocked(toast.warning).mock.calls.length;

  paste(editor, html, text);
  await settled();

  expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before.doc.toJSON());
  expect(editor.prosemirrorView.state.selection.toJSON()).toEqual(before.selection.toJSON());
  expect(manager.undoStack).toEqual(undo);
  expect(manager.redoStack).toEqual(redo);
  expect(vi.mocked(toast.warning).mock.calls.length).toBe(warnings + 1);
  expect(sink.start).not.toHaveBeenCalled();
  expect(sink.onLeftOut).not.toHaveBeenCalled();
}

describe('HTML carrying media', () => {
  it('is read as HTML even when its plain text looks like Markdown, so the picture is not lost', async () => {
    const { editor, sink } = open([{ type: 'paragraph' }]);
    caretIn(editor, 0);

    paste(editor, '<p><b>bold</b> words</p><img src="https://elsewhere.example/a.png">', '**bold** words');
    await settled();

    expect(shape(editor)).toContain('image[pending|]');
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['a line', [{ type: 'paragraph', content: 'lead' }], ['paragraph:leada', 'image[pending|]', 'paragraph:b']],
    ['a table cell', [TABLE], ['table']],
  ])('a picture given only by srcset, pasted on %s, is fetched from its densest candidate', async (_where, blocks, expected) => {
    const { editor, sink } = _where === 'a table cell' ? await openReady(blocks) : open(blocks);
    caretIn(editor, 0);

    paste(
      editor,
      '<p>a</p><img srcset="https://elsewhere.example/i.png 1x, https://elsewhere.example/i2.png 2x"><p>b</p>',
      'a b',
    );
    await settled();

    expect(shape(editor)).toEqual(expected);
    if (_where === 'a table cell') {
      expect(cellShape(editor)).toEqual(['paragraph:cell a', 'image[pending|]', 'paragraph:b']);
      expect(firstCell(editor, 0)).toBe('cell ab');
    }
    expect(sink.start).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'address',
      url: 'https://elsewhere.example/i2.png',
    });
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it.each([
    ['widths, smallest first', 'https://e.example/s.png 320w, https://e.example/b.png 1280w, https://e.example/m.png 640w', 'https://e.example/b.png'],
    ['no descriptors', 'https://e.example/only.png', 'https://e.example/only.png'],
    ['no space after a comma', 'https://e.example/s.png 1x,https://e.example/b.png 2x', 'https://e.example/b.png'],
    ['three candidates and no spaces', 'https://e.example/s.png 1x,https://e.example/m.png 2x,https://e.example/b.png 3x', 'https://e.example/b.png'],
  ])('a picture given only by srcset with %s is fetched from its largest candidate', async (_what, srcset, url) => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, `<p>a</p><img srcset="${srcset}"><p>b</p>`, 'a b');
    await settled();

    expect(sink.start).toHaveBeenCalledExactlyOnceWith(expect.any(String), { kind: 'address', url });
  });

  it('a video does not take the address of a picture inside it', () => {
    const { editor } = open([{ type: 'paragraph' }]);

    const blocks = editor.tryParseHTMLToBlocks('<video><img srcset="https://e.example/poster.png 1x"></video>') as {
      type: string;
      props: Record<string, unknown>;
    }[];

    expect(blocks.filter((block) => block.props['url'] === 'https://e.example/poster.png')).toEqual([]);
  });

  it('HTML holding a td inside an SVG still pastes its words and pictures', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(
      editor,
      '<p>hello</p><img src="https://e.example/b.png">' +
        '<svg><td><foreignObject><img src="https://e.example/a.png"></foreignObject></td></svg>',
      'hello',
    );
    await settled();

    expect(shape(editor)[0]).toBe('paragraph:leadhello');
    expect(sink.start).toHaveBeenCalledWith(expect.any(String), { kind: 'address', url: 'https://e.example/b.png' });
  });
});

describe('where a pasted picture stands and what it shows (inner#1351 A3, A5)', () => {
  /**
   * Pastes HTML or Markdown on the line `lead` and waits for it to settle.
   * @param html - The clipboard's HTML, or '' for plain text.
   * @param text - The clipboard's plain text.
   * @returns The editor and its sink.
   */
  async function pasted(html: string, text: string): Promise<{ editor: Editor; sink: Sink }> {
    const opened = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(opened.editor, 0);
    paste(opened.editor, html, text);
    await settled();
    return opened;
  }

  /**
   * The addresses uploads started from.
   * @param sink - The sink.
   * @returns The addresses.
   */
  function started(sink: Sink): string[] {
    return sink.start.mock.calls.map((call) => (call[1] as { url: string }).url);
  }

  it('a picture whose srcset holds the picture shown is fetched from it, not from a placeholder src', async () => {
    const { sink } = await pasted(
      '<p>a</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" srcset="https://e.example/real.jpg 1x"><p>b</p>',
      'a b',
    );

    expect(started(sink)).toEqual(['https://e.example/real.jpg']);
  });

  it('a picture whose srcset holds only addresses that cannot be fetched is fetched from its src', async () => {
    const { sink } = await pasted('<p>a</p><img src="https://e.example/c.png" srcset="/pic/a.png 1x, /pic/b.png 2x"><p>b</p>', 'a b');

    expect(started(sink)).toEqual(['https://e.example/c.png']);
  });

  it.each([
    ['two pictures in one figure', '<figure><img src="https://e.example/1.png"><img src="https://e.example/2.png"><figcaption>both</figcaption></figure>'],
    [
      'a gallery of figures',
      '<figure class="wp-block-gallery"><figure><img src="https://e.example/1.png"></figure><figure><img src="https://e.example/2.png"><figcaption>two</figcaption></figure></figure>',
    ],
  ])('%s land as a picture each', async (_what, html) => {
    const { sink } = await pasted(`<p>a</p>${html}<p>b</p>`, 'a b');

    expect(started(sink)).toEqual(['https://e.example/1.png', 'https://e.example/2.png']);
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it.each([
    ['a sentence', '<p>see <img src="https://e.example/i.png"> here</p>', 'see here'],
    ['a heading', '<h2>Title <img src="https://e.example/i.png"></h2>', 'Title'],
    ['a sentence in Markdown', '', 'see ![x](https://e.example/i.png) here\n\nnext'],
    ['a Markdown table cell', '', '| a | b |\n|---|---|\n| ![x](https://e.example/i.png) | y |'],
  ])('a picture in %s lands where it stands', async (_what, html, text) => {
    const { editor, sink } = await pasted(html, text);

    expect(started(sink)).toEqual(['https://e.example/i.png']);
    expect(blockOrder(editor)).toContain('image|');
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it('a picture in a sentence splits the sentence where it stands', async () => {
    const { editor } = await pasted('<p>see <img src="https://e.example/i.png"> here</p><p>next</p>', 'see here next');

    expect(shape(editor).map((label) => label.trim())).toEqual(['paragraph:leadsee', 'image[pending|]', 'paragraph:here', 'paragraph:next']);
  });

  it('Markdown carrying a picture pasted into code goes in as its words, with nothing left out', async () => {
    const { editor, sink } = open([{ type: 'codeBlock', content: 'x' }]);
    caretIn(editor, 0);

    paste(editor, '', '![x](https://e.example/i.png)');
    await settled();

    expect(sink.start).not.toHaveBeenCalled();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
    expect(editor.prosemirrorView!.state.doc.textContent).toContain('![x](https://e.example/i.png)');
  });

  it('web content pasted into code puts its words in the code, and a medium it could not read is told as left out', async () => {
    const { editor, sink } = open([{ type: 'codeBlock', content: 'x' }]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><object data="https://e.example/x.swf"><img src="https://e.example/f.png"></object>', 'words');
    await settled();

    // BlockNote reads no <object>, so the picture inside it is not read.
    expect(sink.onLeftOut).toHaveBeenCalledWith(1);
    expect(editor.prosemirrorView!.state.doc.textContent).toContain('words');
  });

  it('a picture the parse still drops is told as left out, pasted or dropped', async () => {
    // An object's fallback content, which the read leaves out.
    const HTML = '<object data="https://e.example/x.swf"><img src="https://e.example/fallback.png"></object>';
    const { sink } = await pasted(`<p>a</p>${HTML}`, 'a x');
    const dropped = open([{ type: 'paragraph', content: 'lead' }]);

    drop(dropped.editor, caretIn(dropped.editor, 0), `<p>a</p>${HTML}`, 'a x');
    await settled();

    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
    expect(dropped.sink.onLeftOut.mock.calls).toEqual([[1]]);
  });
});

describe('a web table whose cells hold media', () => {
  const WITH = '<p>a</p><table><tr><td><img src="https://elsewhere.example/a.png"> x</td><td>y</td></tr></table><p>b</p>';
  const WITHOUT = '<p>a</p><table><tr><td> x</td><td>y</td></tr></table><p>b</p>';

  it('pasted on a line, keeps the table and its media in the original cell', async () => {
    const plain = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(plain.editor, 0);
    paste(plain.editor, WITHOUT, 'a x y b');
    await settled();
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, WITH, 'a x y b');
    await settled();

    expect(shape(editor)).toEqual(shape(plain.editor));
    expect(shape(editor)).toEqual(['paragraph:leada', 'table', 'paragraph:b']);
    expect(cellShape(editor, 1)).toEqual(['image[pending|]', 'paragraph:x']);
    expect(cellShape(editor, 1, 0, 1)).toEqual(['paragraph:y']);
    expect(sink.start).toHaveBeenCalledOnce();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it('dropped on a line, keeps the table and its media in the original cell', async () => {
    const plain = open([{ type: 'paragraph', content: 'lead' }]);
    drop(plain.editor, caretIn(plain.editor, 0), WITHOUT, 'a x y b');
    await settled();
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);

    drop(editor, caretIn(editor, 0), WITH, 'a x y b');
    await settled();

    expect(shape(editor)).toEqual(shape(plain.editor));
    expect(shape(editor)).toEqual(['paragraph:leada', 'table', 'paragraph:b']);
    expect(cellShape(editor, 1)).toEqual(['image[pending|]', 'paragraph:x']);
    expect(cellShape(editor, 1, 0, 1)).toEqual(['paragraph:y']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'a figure in a cell, with its caption',
      '<table><tr><td><figure><img src="https://elsewhere.example/a.png"><figcaption>Cap</figcaption></figure></td></tr></table>',
      '<table><tr><td></td></tr></table>',
      'Cap', '', '',
    ],
    [
      'a figure around the whole table',
      '<figure><table><tr><td><img src="https://elsewhere.example/a.png"> x</td></tr></table><figcaption>T</figcaption></figure>',
      '<figure><table><tr><td> x</td></tr></table></figure>',
      // The figure's only medium takes its caption, as BlockNote reads a figure.
      'T', 'x', ' x',
    ],
  ])('with %s, keeps the medium and its caption in the original cell', async (_what, html, plainHtml, caption, words, plainWords) => {
    const plain = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(plain.editor, 0);
    paste(plain.editor, plainHtml, 'x');
    await settled();
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, html, 'x');
    await settled();

    expect(shape(editor)).toEqual(shape(plain.editor));
    // Splitting at a medium cleans the whitespace at the cut (§5.4.2).
    expect(firstCell(editor, 1)).toBe(words);
    expect(firstCell(plain.editor, 1)).toBe(plainWords);
    expect(cellShape(editor, 1)).toEqual(_what === 'a figure in a cell, with its caption'
      ? [`image[pending|${caption}]`]
      : [`image[pending|${caption}]`, 'paragraph:x']);
    expect(blockOrder(editor).filter((block) => block.startsWith('image|'))).toEqual([`image|${caption}`]);
    expect(sink.start).toHaveBeenCalledOnce();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it('pasted into a table cell, rejects the table mixed with surrounding prose', async () => {
    await rejectInCell(WITH, 'a x y b');
  });
});

describe('with the caret in a table cell (A13)', () => {
  it('puts the words and pending medium in the cell', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png" alt="A">', 'words');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell words');
    expect(shape(editor)).toEqual(['table', 'paragraph:after']);
    expect(cellShape(editor)).toEqual(['paragraph:cell words', 'image[pending|]', 'paragraph:']);
    const image = cellBlocks(editor)[1]!;
    expect(image.props['name']).toBe('A');
    expect(sink.start).toHaveBeenCalledExactlyOnceWith(image.props['uploadId'], {
      kind: 'address',
      url: 'https://elsewhere.example/a.png',
    });
  });

  it('carries a figure\'s caption, keeps a medium of ours as it is, and loses none', async () => {
    const { editor } = await openReady([TABLE]);
    caretIn(editor, 0);

    paste(
      editor,
      '<figure><img src="https://elsewhere.example/a.png"><figcaption>Cap</figcaption></figure>' +
        `<p>words</p><img src="${OURS}b.png">`,
      'Cap words',
    );
    await settled();

    expect(shape(editor)).toEqual(['table']);
    expect(cellShape(editor)).toEqual(['paragraph:cell ', 'image[pending|Cap]', 'paragraph:words', `image[${OURS}b.png|]`, 'paragraph:']);
    expect(firstCell(editor, 0)).toBe('cell words');
  });

  it('counts a medium it cannot fetch as left out', async () => {
    const { editor, sink } = await openReady([TABLE]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="http://elsewhere.example/a.png">', 'words');
    await settled();

    expect(shape(editor)).toEqual(['table']);
    expect(sink.onLeftOut).toHaveBeenCalledWith(1);
    expect(firstCell(editor, 0)).toBe('cell words');
  });

  it('a drop of web content puts the words and pending medium in the cell', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(editor, 0);

    drop(editor, at, '<p>dropped</p><img src="https://elsewhere.example/a.png">', 'dropped');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell dropped');
    expect(shape(editor)).toEqual(['table', 'paragraph:after']);
    expect(cellShape(editor)).toEqual(['paragraph:cell dropped', 'image[pending|]', 'paragraph:']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('plain text carrying a Markdown picture puts its words and picture in the cell', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '', 'words\n\n![alt](https://elsewhere.example/a.png)');
    await settled();

    expect(shape(editor)).toEqual(['table', 'paragraph:after']);
    expect(cellShape(editor)).toEqual(['paragraph:cell words', 'image[pending|]', 'paragraph:']);
    expect(firstCell(editor, 0)).toBe('cell words');
    expect(cellBlocks(editor)[1]!.props['name']).toBe('alt');
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('rejects prose mixed with a ragged table, with or without its picture', async () => {
    const TABLE_HTML = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>';
    await rejectInCell(`<p>words</p>${TABLE_HTML}`, 'words a b c', [TABLE, { type: 'paragraph', content: 'after' }]);
    await rejectInCell(`<p>words</p><img src="https://elsewhere.example/a.png">${TABLE_HTML}`, 'words a b c', [TABLE, { type: 'paragraph', content: 'after' }]);
  });

  it('a picture alone keeps the original words and lands as a block in the cell', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '<img src="https://elsewhere.example/a.png">', '');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell ');
    expect(shape(editor)).toEqual(['table', 'paragraph:after']);
    expect(cellShape(editor)).toEqual(['paragraph:cell ', 'image[pending|]', 'paragraph:']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['a line break', '<img src="https://elsewhere.example/a.png"><br>', ['paragraph:cell ', 'image[pending|]', 'paragraph:']],
    ['a rule', '<img src="https://elsewhere.example/a.png"><hr>', ['paragraph:cell ', 'image[pending|]', 'divider:', 'paragraph:']],
    ['a break inside its paragraph', '<p><img src="https://elsewhere.example/a.png"><br></p>', ['paragraph:cell ', 'image[pending|]', 'paragraph:']],
  ])('a picture followed by %s keeps its ordinary blocks inside the cell', async (_what, html, blocks) => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, html, '');
    await settled();

    expect(shape(editor)).toEqual(['table', 'paragraph:after']);
    expect(cellShape(editor)).toEqual(blocks);
    expect(firstCell(editor, 0)).toBe('cell ');
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('a drop of a picture and a line break keeps the picture in the cell', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(editor, 0);

    drop(editor, at, '<img src="https://elsewhere.example/a.png"><br>', '');
    await settled();

    expect(shape(editor)).toEqual(['table', 'paragraph:after']);
    expect(cellShape(editor)).toEqual(['paragraph:cell ', 'image[pending|]', 'paragraph:']);
    expect(firstCell(editor, 0)).toBe('cell ');
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('web content dropped on a cell with the caret elsewhere keeps its words and picture in that cell', async () => {
    const HTML = '<h2>Head</h2><p>para</p>';
    const plain = await openReady([{ type: 'paragraph', content: 'before' }, TABLE, { type: 'paragraph', content: 'after' }]);
    const plainAt = caretIn(plain.editor, 1);
    caretIn(plain.editor, 2);
    drop(plain.editor, plainAt, HTML, 'Head para');
    await settled();
    const withPicture = await openReady([{ type: 'paragraph', content: 'before' }, TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(withPicture.editor, 1);
    caretIn(withPicture.editor, 2);

    drop(withPicture.editor, at, `${HTML}<img src="https://elsewhere.example/a.png">`, 'Head para');
    await settled();

    expect(shape(withPicture.editor)).toEqual(shape(plain.editor));
    expect(shape(withPicture.editor)).toEqual(['paragraph:before', 'table', 'paragraph:after']);
    expect(cellShape(withPicture.editor, 1)).toEqual(['paragraph:cell Head', 'paragraph:para', 'image[pending|]', 'paragraph:']);
    expect(firstCell(withPicture.editor, 1)).toBe('cell Headpara');
    expect(firstCell(withPicture.editor, 1)).toBe(firstCell(plain.editor, 1));
    expect(withPicture.sink.start).toHaveBeenCalledOnce();
  });

  it('is taken away by one undo', async () => {
    const { editor, manager } = await openReady([TABLE]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png">', 'words');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['table']);
    expect(firstCell(editor, 0)).toBe('cell ');
  });
});

describe('web content dropped in (A5)', () => {
  it('turns an outside picture into a pending block, as a paste does', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    const view = editor.prosemirrorView!;
    const at = view.state.doc.content.size - 2;
    view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 1, clientY: 1 });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['text/html', 'text/plain'],
        files: [],
        items: [],
        getData: (type: string): string =>
          type === 'text/html' ? '<p>dropped</p><img src="https://elsewhere.example/a.png">' : type === 'text/plain' ? 'dropped' : '',
      },
    });

    view.dom.dispatchEvent(event);
    await settled();

    expect(shape(editor)).toContain('image[pending|]');
    expect(sink.start).toHaveBeenCalledOnce();
  });
});

describe('a paste or a drop is an undo step of its own (A6)', () => {
  it('typing just before a paste of web content stays when the paste is undone', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    type(editor, ' typed');
    paste(editor, '<p>web words</p><img src="https://elsewhere.example/a.png">', 'web words');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead typed']);
  });

  it('typing just after a paste is undone on its own', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, '<p>web words</p><img src="https://elsewhere.example/a.png">', 'web words');
    await settled();
    type(editor, 'Z');
    manager.undo();

    expect(shape(editor).join(' ')).not.toContain('Z');
    expect(shape(editor)).toContain('image[pending|]');
  });

  it('typing just before a drop of web content stays when the drop is undone', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    const at = caretIn(editor, 0);

    type(editor, ' typed');
    drop(editor, at + ' typed'.length, '<p>dropped</p><img src="https://elsewhere.example/a.png">', 'dropped');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead typed']);
  });

  it('typing just before a paste in a table cell stays when the paste is undone', async () => {
    const { editor, manager } = await openReady([TABLE]);
    caretIn(editor, 0);

    type(editor, 'typed');
    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png">', 'words');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['table']);
    expect(firstCell(editor, 0)).toBe('cell typed');
  });

  it('a paste that puts back the very words it replaces leaves the typing after it one step', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead word' }]);
    select(editor, 8, 12);

    paste(editor, '', 'word');
    await settled();
    type(editor, 'x');
    type(editor, 'y');
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead word']);
  });

  it('typing just before a plain text paste stays when the paste is undone', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    type(editor, ' typed');
    paste(editor, '', ' plain');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead typed']);
  });

  it('typing just before a table pasted into a cell stays when the paste is undone', async () => {
    const { editor, manager } = await openReady([TABLE]);
    caretIn(editor, 0);

    type(editor, 'typed');
    paste(editor, '<table><tr><td>a</td><td>b</td></tr></table>', 'a\tb');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['table']);
    expect(firstCell(editor, 0)).toBe('cell typed');
  });

  it('typing just before an address pasted over a selection stays when the paste is undone', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'lead word' }]);
    caretIn(editor, 0);
    type(editor, ' typed');
    select(editor, 13, 18);

    paste(editor, '', 'https://x.example/');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['paragraph:lead word typed']);
  });

  it('typing just before web content pasted over a cell selection stays when the paste is undone', async () => {
    const { editor, manager } = await openReady([TWO_CELLS]);
    caretIn(editor, 0);
    type(editor, 'typed');
    const view = editor.prosemirrorView!;
    const cells: number[] = [];
    view.state.doc.descendants((node, at) => {
      if (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader') cells.push(at);
      return true;
    });
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[1]!)));

    paste(editor, '<p>w</p><img src="https://elsewhere.example/a.png">', 'w');
    await settled();
    manager.undo();

    expect(shape(editor)).toEqual(['table']);
    expect(firstCell(editor, 0)).toBe('c1typed');
  });
});

describe('an address and pictures pasted over selected words', () => {
  it('lands all of it: the address is no link to make of the selection', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead word' }]);
    select(editor, 8, 12);

    paste(editor, '<p><a href="https://x.example/">https://x.example/</a></p><img src="https://elsewhere.example/a.png">', 'https://x.example/');
    await settled();

    expect(sink.start).toHaveBeenCalledOnce();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
    expect(editor.prosemirrorView!.state.doc.textContent).toContain('https://x.example/');
  });

  it('tells only the pictures it could not fetch as left out', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead word' }]);
    select(editor, 8, 12);

    paste(
      editor,
      '<p><a href="https://x.example/">https://x.example/</a></p>' +
        '<img src="http://elsewhere.example/a.png"><img src="https://elsewhere.example/b.png">',
      'https://x.example/',
    );
    await settled();

    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
    expect(sink.start).toHaveBeenCalledOnce();
  });
});


/**
 * Every block but the media, nested ones too, without ids.
 * @param editor - The editor.
 * @returns The blocks as JSON.
 */
function withoutMediaBlocks(editor: Editor): string {
  type Block = { type: string; children?: Block[] };
  const strip = (blocks: Block[]): Block[] =>
    blocks
      .filter((block) => !['image', 'video', 'audio'].includes(block.type))
      .map((block) => ({ ...block, children: strip(block.children ?? []) }));
  return JSON.stringify(strip(editor.document as Block[]), (key, value: unknown) => (key === 'id' ? undefined : value));
}

describe('pasted in the middle of a line', () => {
  it.each([
    ['an outside picture', 'https://elsewhere.example/a.png', 1],
    ['a picture it cannot fetch', 'http://elsewhere.example/a.png', 0],
  ])('web content ending in a table, with %s, leaves the rest of the line as it does with a picture of ours', async (_what, src, starts) => {
    const html = (url: string): string => `<p>words</p><img src="${url}"><table><tr><td>a</td></tr></table>`;
    const ours = open([{ type: 'paragraph', content: 'lead tail' }]);
    select(ours.editor, 8);
    paste(ours.editor, html(`${OURS}a.png`), 'words a');
    await settled();
    const other = open([{ type: 'paragraph', content: 'lead tail' }]);
    select(other.editor, 8);

    paste(other.editor, html(src), 'words a');
    await settled();

    expect(withoutMediaBlocks(other.editor)).toBe(withoutMediaBlocks(ours.editor));
    expect(other.sink.start).toHaveBeenCalledTimes(starts);
  });
});

describe('the body\'s own HTML pasted into a table cell', () => {
  it('keeps a medium nested under its original row inside the cell', async () => {
    const rows = (children: unknown[]): unknown[] => [
      { type: 'paragraph', content: 'p1', children },
      { type: 'paragraph', content: 'kid' },
    ];
    const plain = await openReady([TABLE]);
    caretIn(plain.editor, 0);
    paste(plain.editor, plain.editor.blocksToFullHTML(rows([]) as never), 'p1\nkid');
    await settled();
    const withMedium = await openReady([TABLE]);
    caretIn(withMedium.editor, 0);

    paste(
      withMedium.editor,
      withMedium.editor.blocksToFullHTML(rows([{ type: 'image', props: { url: 'https://elsewhere.example/a.png' } }]) as never),
      'p1\nkid',
    );
    await settled();

    expect(firstCell(withMedium.editor, 0)).toBe(firstCell(plain.editor, 0));
    expect(firstCell(withMedium.editor, 0)).toBe('cell p1kid');
    expect(shape(withMedium.editor)).toEqual(['table']);
    expect(cellShape(withMedium.editor)).toEqual(['paragraph:cell ', 'paragraph:p1', 'paragraph:kid']);
    expect(blockOrder(withMedium.editor)).toEqual(['docTable', 'docTableRow', 'docTableCell', 'paragraph', 'paragraph', 'image|', 'paragraph']);
    const nested = cellBlocks(withMedium.editor)[1]!.children!;
    expect(nested.map((block) => block.type)).toEqual(['image']);
    expect(nested[0]!.props['url']).toBe('');
    expect(nested[0]!.props['uploadId']).toEqual(expect.any(String));
    expect(nested[0]!.props['uploadId']).not.toBe('');
    expect(withMedium.sink.start).toHaveBeenCalledExactlyOnceWith(nested[0]!.props['uploadId'], {
      kind: 'address', url: 'https://elsewhere.example/a.png',
    });
  });
});
