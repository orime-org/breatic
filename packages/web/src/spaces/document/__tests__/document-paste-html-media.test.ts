// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Web content with media, pasted or dropped the way a reader does it
 * (inner#1351 + inner#1390 design §5.1, §5.4; A5, A7): HTML carrying media is
 * read as HTML even when its plain text looks like Markdown; with the caret
 * in a table cell the words go into the cell and every medium lands under
 * the table; a drop of web content is judged as a paste is.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CellSelection } from '@tiptap/pm/tables';

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

afterEach(unmountAll);

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
    ['a table cell', [TABLE], ['table', 'image[pending|]']],
  ])('a picture given only by srcset, pasted on %s, is fetched from its densest candidate', async (_where, blocks, expected) => {
    const { editor, sink } = open(blocks);
    caretIn(editor, 0);

    paste(
      editor,
      '<p>a</p><img srcset="https://elsewhere.example/i.png 1x, https://elsewhere.example/i2.png 2x"><p>b</p>',
      'a b',
    );
    await settled();

    expect(shape(editor)).toEqual(expected);
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

  it('web content pasted into code goes in as its words, with nothing told left out', async () => {
    const { editor, sink } = open([{ type: 'codeBlock', content: 'x' }]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><object data="https://e.example/x.swf"><img src="https://e.example/f.png"></object>', 'words');
    await settled();

    expect(sink.onLeftOut).not.toHaveBeenCalled();
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

  /**
   * The labels a paste without the media gives, with the media pending right
   * after the table.
   * @param plain - The editor the media-less HTML went into.
   * @returns The labels.
   */
  function underTable(plain: Editor): string[] {
    const labels = shape(plain);
    labels.splice(labels.indexOf('table') + 1, 0, 'image[pending|]');
    return labels;
  }

  it('pasted on a line, lands as it does without them, the media under the table', async () => {
    const plain = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(plain.editor, 0);
    paste(plain.editor, WITHOUT, 'a x y b');
    await settled();
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, WITH, 'a x y b');
    await settled();

    expect(shape(editor)).toEqual(underTable(plain.editor));
    expect(sink.start).toHaveBeenCalledOnce();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });

  it('dropped on a line, lands as it does without them, the media under the table', async () => {
    const plain = open([{ type: 'paragraph', content: 'lead' }]);
    drop(plain.editor, caretIn(plain.editor, 0), WITHOUT, 'a x y b');
    await settled();
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);

    drop(editor, caretIn(editor, 0), WITH, 'a x y b');
    await settled();

    expect(shape(editor)).toEqual(underTable(plain.editor));
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'a figure in a cell, with its caption',
      '<table><tr><td><figure><img src="https://elsewhere.example/a.png"><figcaption>Cap</figcaption></figure></td></tr></table>',
      '<table><tr><td></td></tr></table>',
      'Cap',
    ],
    [
      'a figure around the whole table',
      '<figure><table><tr><td><img src="https://elsewhere.example/a.png"> x</td></tr></table><figcaption>T</figcaption></figure>',
      '<figure><table><tr><td> x</td></tr></table><figcaption>T</figcaption></figure>',
      '',
    ],
  ])('with %s, lands as it does without the medium, the medium after the table', async (_what, html, plainHtml, caption) => {
    const plain = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(plain.editor, 0);
    paste(plain.editor, plainHtml, 'x');
    await settled();
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, html, 'x');
    await settled();

    expect(withoutMediaBlocks(editor)).toBe(withoutMediaBlocks(plain.editor));
    const order = blockOrder(editor);
    expect(order.indexOf(`image|${caption}`)).toBeGreaterThan(order.indexOf('table'));
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('pasted into a table cell, puts its media under the table the caret is in', async () => {
    const { editor, sink } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, WITH, 'a x y b');
    await settled();

    expect(shape(editor)[1]).toBe('image[pending|]');
    expect(sink.start).toHaveBeenCalledOnce();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });
});

describe('with the caret in a table cell (A7)', () => {
  it('puts the words in the cell and the medium under the table, pending', async () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="https://elsewhere.example/a.png" alt="A">', 'words');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell words');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    const image = (editor.document as { props: Record<string, unknown> }[])[1]!;
    expect(sink.start).toHaveBeenCalledExactlyOnceWith(image.props['uploadId'], {
      kind: 'address',
      url: 'https://elsewhere.example/a.png',
    });
  });

  it('carries a figure\'s caption, keeps a medium of ours as it is, and loses none', async () => {
    const { editor } = open([TABLE]);
    caretIn(editor, 0);

    paste(
      editor,
      '<figure><img src="https://elsewhere.example/a.png"><figcaption>Cap</figcaption></figure>' +
        `<p>words</p><img src="${OURS}b.png">`,
      'Cap words',
    );
    await settled();

    expect(shape(editor)).toEqual(['table', 'image[pending|Cap]', `image[${OURS}b.png|]`]);
    expect(firstCell(editor, 0)).toBe('cell words');
  });

  it('counts a medium it cannot fetch as left out', async () => {
    const { editor, sink } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, '<p>words</p><img src="http://elsewhere.example/a.png">', 'words');
    await settled();

    expect(shape(editor)).toEqual(['table']);
    expect(sink.onLeftOut).toHaveBeenCalledWith(1);
    expect(firstCell(editor, 0)).toBe('cell words');
  });

  it('a drop of web content puts the words in the cell and the medium under the table, pending', async () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(editor, 0);

    drop(editor, at, '<p>dropped</p><img src="https://elsewhere.example/a.png">', 'dropped');
    await settled();

    expect(firstCell(editor, 0)).toContain('cell dropped');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('plain text carrying a Markdown picture puts the words in the cell and the picture under the table', async () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '', 'words\n\n![alt](https://elsewhere.example/a.png)');
    await settled();

    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('web content with a picture and a ragged table lands as it does without the picture, the picture under the table', async () => {
    const TABLE_HTML = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>';
    const plain = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(plain.editor, 0);
    paste(plain.editor, `<p>words</p>${TABLE_HTML}`, 'words a b c');
    await settled();
    const withPicture = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(withPicture.editor, 0);

    paste(withPicture.editor, `<p>words</p><img src="https://elsewhere.example/a.png">${TABLE_HTML}`, 'words a b c');
    await settled();

    const expected = shape(plain.editor);
    expected.splice(expected.indexOf('table') + 1, 0, 'image[pending|]');
    expect(shape(withPicture.editor)).toEqual(expected);
    expect(withPicture.sink.start).toHaveBeenCalledOnce();
  });

  it('a picture alone puts nothing in the cell and the picture under the table', async () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, '<img src="https://elsewhere.example/a.png">', '');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell ');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['a line break', '<img src="https://elsewhere.example/a.png"><br>'],
    ['a rule', '<img src="https://elsewhere.example/a.png"><hr>'],
    ['a break inside its paragraph', '<p><img src="https://elsewhere.example/a.png"><br></p>'],
  ])('a picture followed by %s that leaves the cell as it was still lands under the table', async (_what, html) => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);

    paste(editor, html, '');
    await settled();

    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('a drop of a picture and a line break that leaves the cell as it was still lands the picture under the table', async () => {
    const { editor, sink } = open([TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(editor, 0);

    drop(editor, at, '<img src="https://elsewhere.example/a.png"><br>', '');
    await settled();

    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'paragraph:after']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('web content dropped on a cell with the caret elsewhere lands as it does without its picture, the picture under the table', async () => {
    const HTML = '<h2>Head</h2><p>para</p>';
    const plain = open([{ type: 'paragraph', content: 'before' }, TABLE, { type: 'paragraph', content: 'after' }]);
    const plainAt = caretIn(plain.editor, 1);
    caretIn(plain.editor, 2);
    drop(plain.editor, plainAt, HTML, 'Head para');
    await settled();
    const withPicture = open([{ type: 'paragraph', content: 'before' }, TABLE, { type: 'paragraph', content: 'after' }]);
    const at = caretIn(withPicture.editor, 1);
    caretIn(withPicture.editor, 2);

    drop(withPicture.editor, at, `${HTML}<img src="https://elsewhere.example/a.png">`, 'Head para');
    await settled();

    const expected = shape(plain.editor);
    expected.splice(expected.indexOf('table') + 1, 0, 'image[pending|]');
    expect(shape(withPicture.editor)).toEqual(expected);
    expect(firstCell(withPicture.editor, 1)).toBe(firstCell(plain.editor, 1));
  });

  it('is taken away by one undo', async () => {
    const { editor, manager } = open([TABLE]);
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
    const { editor, manager } = open([TABLE]);
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
    const { editor, manager } = open([TABLE]);
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
    const { editor, manager } = open([TWO_CELLS]);
    caretIn(editor, 0);
    type(editor, 'typed');
    const view = editor.prosemirrorView!;
    const cells: number[] = [];
    view.state.doc.descendants((node, at) => {
      if (node.type.name === 'tableCell') cells.push(at);
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

describe('a paste the editor does not put in', () => {
  it('counts its media as left out when another hook takes the paste instead', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead word' }]);
    select(editor, 8, 12);

    // The link hook takes a paste whose words are one address, over a selection.
    paste(editor, '<p><a href="https://x.example/">https://x.example/</a></p><img src="https://elsewhere.example/a.png">', 'https://x.example/');
    await settled();
    await Promise.resolve();

    expect(sink.start).not.toHaveBeenCalled();
    expect(sink.onLeftOut).toHaveBeenCalledWith(1);
  });

  it('tells how many were left out once, counting those it could not fetch with those the hook kept out', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead word' }]);
    select(editor, 8, 12);

    paste(
      editor,
      '<p><a href="https://x.example/">https://x.example/</a></p>' +
        '<img src="http://elsewhere.example/a.png"><img src="https://elsewhere.example/b.png">',
      'https://x.example/',
    );
    await settled();

    expect(sink.onLeftOut.mock.calls).toEqual([[2]]);
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
  it('a medium nested under a row lands under the table and the cell gets the words as without it', async () => {
    const rows = (children: unknown[]): unknown[] => [
      { type: 'paragraph', content: 'p1', children },
      { type: 'paragraph', content: 'kid' },
    ];
    const plain = open([TABLE]);
    caretIn(plain.editor, 0);
    paste(plain.editor, plain.editor.blocksToFullHTML(rows([]) as never), 'p1\nkid');
    await settled();
    const withMedium = open([TABLE]);
    caretIn(withMedium.editor, 0);

    paste(
      withMedium.editor,
      withMedium.editor.blocksToFullHTML(rows([{ type: 'image', props: { url: 'https://elsewhere.example/a.png' } }]) as never),
      'p1\nkid',
    );
    await settled();

    expect(firstCell(withMedium.editor, 0)).toBe(firstCell(plain.editor, 0));
    expect(shape(withMedium.editor)).toEqual(['table', 'image[pending|]']);
  });
});
