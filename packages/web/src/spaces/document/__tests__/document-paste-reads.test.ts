// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a paste of web content reads, and that every medium it carries lands
 * or is told as left out (inner#1351 + inner#1390 design §5.4, A3, A5): the
 * format read is the one BlockNote would read, the media in it land where
 * they stand in the line, and none goes without the user knowing.
 */

import { act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { toast } from '@web/lib/toast';
import { tableBlock } from './table-fixtures';

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
  pasteFormats,
  positionOf,
  select,
  settled,
  shape,
  unmountAll,
  type Editor,
  type Sink,
} from './paste-harness';

beforeEach(() => {
  vi.spyOn(toast, 'warning').mockReturnValue('paste-reads-warning');
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const U = 'https://e.example/';

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
 * Captures everything an unsupported cell paste must leave unchanged.
 * @param opened - The mounted body.
 * @returns The body, selection, history and warning count before the event.
 */
function pasteState({ editor, manager }: ReturnType<typeof open>): {
  document: unknown; selection: unknown; undo: unknown[]; redo: unknown[]; warnings: number;
} {
  return {
    document: editor.prosemirrorView.state.doc.toJSON(),
    selection: editor.prosemirrorView.state.selection.toJSON(),
    undo: manager.undoStack.slice(),
    redo: manager.redoStack.slice(),
    warnings: vi.mocked(toast.warning).mock.calls.length,
  };
}

/**
 * Checks A14 rejection without losing the input to a fallback paste.
 * @param opened - The mounted body and its upload sink.
 * @param before - State captured before the event.
 */
function expectRejected(opened: ReturnType<typeof open>, before: ReturnType<typeof pasteState>): void {
  const { warnings, ...after } = pasteState(opened);
  const { warnings: previousWarnings, ...unchanged } = before;
  expect(after).toEqual(unchanged);
  expect(warnings).toBe(previousWarnings + 1);
  expect(opened.sink.start).not.toHaveBeenCalled();
  expect(opened.sink.onLeftOut).not.toHaveBeenCalled();
}

/**
 * How many media blocks the document holds, nested ones too.
 * @param editor - The editor.
 * @returns The count.
 */
function mediaBlocks(editor: Editor): number {
  let count = 0;
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (['image', 'video', 'audio'].includes(node.type.name)) count += 1;
    return true;
  });
  return count;
}

/**
 * How many media the user was told were left out.
 * @param sink - The sink.
 * @returns The count.
 */
function told(sink: Sink): number {
  return sink.onLeftOut.mock.calls.reduce((sum, call) => sum + (call[0] as number), 0);
}

/** Web content, each with how many media it carries. */
const HTML_CASES: [string, string, string, number][] = [
  ['a picture between paragraphs', `<p>a</p><img src="${U}a.png"><p>b</p>`, 'a b', 1],
  ['two pictures in one figure', `<p>a</p><figure><img src="${U}1.png"><img src="${U}2.png"><figcaption>both</figcaption></figure><p>b</p>`, 'a b', 2],
  [
    'a gallery of figures',
    `<figure class="wp-block-gallery"><figure><img src="${U}1.png"></figure><figure><img src="${U}2.png"><figcaption>two</figcaption></figure></figure>`,
    'two',
    2,
  ],
  ['a lazy picture', `<p>a</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" srcset="${U}real.jpg 1x"><p>b</p>`, 'a b', 1],
  ['a picture given by widths', `<img srcset="${U}s.png 320w,${U}b.png 1280w">`, '', 1],
  ['a picture with only relative addresses', '<p>a</p><img srcset="/a.png 1x, /b.png 2x"><p>b</p>', 'a b', 1],
  ['a picture in a sentence', `<p>see <img src="${U}i.png"> here</p>`, 'see here', 1],
  ['a picture in a heading', `<h2>Title <img src="${U}h.png"></h2>`, 'Title', 1],
  ['a picture before a line break', `<p>see <img src="${U}i.png"><br>here</p>`, 'see here', 1],
  ['a picture first', `<img src="${U}x.png"><p>after</p>`, 'after', 1],
  ['a picture last', `<p>before</p><img src="${U}x.png">`, 'before', 1],
  ['an object\'s fallback picture', `<p>a</p><object data="${U}x.swf"><img src="${U}f.png"></object>`, 'a x', 1],
  ['a picture in a web table cell', `<p>a</p><table><tr><td><img src="${U}c.png"> x</td><td>y</td></tr></table>`, 'a x y', 1],
  ['a video and an audio', `<video src="${U}v.mp4"></video><audio src="${U}s.mp3"></audio>`, '', 2],
  ['a picture it cannot fetch', '<p>a</p><img src="http://e.example/a.png">', 'a', 1],
  ['a picture of ours', `<p>a</p><img src="${OURS}o.png">`, 'a', 1],
  ['a glyph picture in a sentence', `<p>I love <img class="emoji" alt="x" src="${U}1f600.png"> it</p>`, 'I love x it', 1],
  ['HTML whose plain text looks like Markdown', `<p><b>bold</b> words</p><img src="${U}a.png">`, '**bold** words', 1],
];

/** Plain text and Markdown, each with how many media it carries. */
const TEXT_CASES: [string, Record<string, string>, number][] = [
  ['Markdown as plain text', { 'text/plain': `see ![x](${U}m.png) here\n\nnext` }, 1],
  ['a Markdown table', { 'text/plain': `| a | b |\n|---|---|\n| ![x](${U}t.png) | y |` }, 1],
  ['Markdown the clipboard says is Markdown', { 'text/markdown': `a ![x](${U}m.png) b` }, 1],
  [
    'HTML without media and plain text carrying a Markdown picture',
    { 'text/html': `<pre>a ![x](${U}a.png) **b**</pre>`, 'text/plain': `a ![x](${U}a.png) **b**` },
    1,
  ],
];

describe('every medium a paste carries lands or is told as left out', () => {
  it.each(HTML_CASES)('%s, pasted on a line', async (_what, html, text, media) => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, html, text);
    await settled();

    expect(mediaBlocks(editor) + told(sink)).toBe(media);
    expect(sink.onLeftOut.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each(HTML_CASES)('%s, pasted in the middle of a line', async (_what, html, text, media) => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    select(editor, positionOf(editor, 'lead', 2));

    paste(editor, html, text);
    await settled();

    expect(mediaBlocks(editor) + told(sink)).toBe(media);
  });

  it.each(HTML_CASES)('%s, pasted in a table cell under A12–A14', async (what, html, text, media) => {
    const opened = await openReady([TABLE]);
    const { editor, sink } = opened;
    caretIn(editor, 0);
    const before = pasteState(opened);

    paste(editor, html, text);
    await settled();

    if (what === 'a picture in a web table cell') {
      // This input also carries a nonempty paragraph before its table (A14).
      expectRejected(opened, before);
    } else {
      expect(mediaBlocks(editor) + told(sink)).toBe(media);
      expect(shape(editor)).toEqual(['table']);
    }
  });

  it.each(HTML_CASES)('%s, dropped on a line', async (_what, html, text, media) => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);

    drop(editor, caretIn(editor, 0), html, text);
    await settled();

    expect(mediaBlocks(editor) + told(sink)).toBe(media);
  });

  it.each(TEXT_CASES)('%s, pasted on a line', async (_what, formats, media) => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    pasteFormats(editor, formats);
    await settled();

    expect(mediaBlocks(editor) + told(sink)).toBe(media);
  });

  it('web content pasted over a selection running from code into a paragraph', async () => {
    const { editor, sink } = open([
      { type: 'codeBlock', content: 'code' },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'code', 2), positionOf(editor, 'tail', 2));

    paste(editor, `<p>a <img src="${U}k.png"> b</p>`, 'a b');
    await settled();

    expect(mediaBlocks(editor) + told(sink)).toBe(1);
  });
});

describe('the format a paste reads', () => {
  it('Markdown the clipboard says is Markdown lands its picture where it stands', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    pasteFormats(editor, { 'text/markdown': `a ![x](${U}m.png) b` });
    await settled();

    expect(shape(editor)).toEqual(['paragraph:leada', 'image[pending|]', 'paragraph:b']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('plain text carrying a Markdown picture is read as Markdown when the HTML carries no media', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    pasteFormats(editor, { 'text/html': `<pre>a ![x](${U}a.png) b</pre>`, 'text/plain': `a ![x](${U}a.png) b` });
    await settled();

    expect(shape(editor)).toEqual(['paragraph:leada', 'image[pending|]', 'paragraph:b']);
    expect(sink.start).toHaveBeenCalledOnce();
  });
});

describe('a medium at an edge of what is pasted in the middle of a line', () => {
  it.each([
    ['first', `<img src="${U}x.png"><p>after</p>`, ['paragraph:le', 'image[pending|]', 'paragraph:afterad']],
    ['last', `<p>before</p><img src="${U}x.png">`, ['paragraph:lebefore', 'image[pending|]', 'paragraph:ad']],
    ['alone', `<img src="${U}x.png">`, ['paragraph:le', 'image[pending|]', 'paragraph:ad']],
  ])('lands beside the line when it comes %s', async (_where, html, expected) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
    select(editor, positionOf(editor, 'lead', 2));

    paste(editor, html, 'x');
    await settled();

    expect(shape(editor)).toEqual(expected);
  });
});

describe('a line split around a picture', () => {
  it.each([
    ['a break after it', `<p>see <img src="${U}i.png"><br>here</p>`],
    ['a break before it', `<p>see<br><img src="${U}i.png"> here</p>`],
    ['a picture in bold text with a break after it', `<p><b>see <img src="${U}i.png"><br>here</b></p>`],
    ['a picture wrapped in a span with a break after it', `<p><span>see </span><span><img src="${U}i.png"></span><br><span>here</span></p>`],
    ['two breaks on each side', `<p>see<br><br><img src="${U}i.png"><br><br>here</p>`],
    ['a space on each side', `<p>see <img src="${U}i.png"> here</p>`],
    ['a space on each side, in marks', `<p><strong>see </strong><img src="${U}i.png"><em> here</em></p>`],
  ])('keeps no blank line and no space from %s, pasted or dropped', async (_what, html) => {
    for (const how of ['paste', 'drop'] as const) {
      const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
      const at = caretIn(editor, 0);

      if (how === 'paste') paste(editor, html, 'see here');
      else drop(editor, at, html, 'see here');
      await settled();

      expect(shape(editor)).toEqual(['paragraph:leadsee', 'image[pending|]', 'paragraph:here']);
    }
  });

  it('leaves no empty heading behind a picture ending a heading, pasted or dropped', async () => {
    for (const how of ['paste', 'drop'] as const) {
      const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
      const at = caretIn(editor, 0);

      if (how === 'paste') paste(editor, `<h2>Title<img src="${U}i.png"></h2>`, 'Title');
      else drop(editor, at, `<h2>Title<img src="${U}i.png"></h2>`, 'Title');
      await settled();

      expect(shape(editor)).toEqual(['paragraph:leadTitle', 'image[pending|]', 'paragraph:']);
    }
  });

});

describe('web content with a picture in a sentence, landing in a table cell', () => {
  /**
   * Pastes or drops one clipboard into a one-cell table.
   * @param how - Paste or drop.
   * @param formats - The clipboard.
   * @returns The cell's words, its blocks and the labels of the top-level blocks.
   */
  async function inCell(how: 'paste' | 'drop', formats: Record<string, string>): Promise<{ cell: string; blocks: string[]; rows: string[] }> {
    const { editor } = await openReady([TABLE]);
    const at = caretIn(editor, 0);
    if (how === 'paste') pasteFormats(editor, formats);
    else drop(editor, at, formats['text/html'] ?? '', formats['text/plain'] ?? '');
    await settled();
    return { cell: firstCell(editor, 0), blocks: cellShape(editor, 0), rows: shape(editor) };
  }

  it.each([
    ['pasted as HTML', 'paste', { 'text/html': `<p>see <img src="${U}i.png"> here</p>`, 'text/plain': 'see here' }],
    ['pasted as Markdown', 'paste', { 'text/markdown': `see ![x](${U}i.png) here` }],
    ['dropped', 'drop', { 'text/html': `<p>see <img src="${U}i.png"> here</p>`, 'text/plain': 'see here' }],
  ] as const)('%s, keeps the split words and picture as blocks in the cell', async (_what, how, withPicture) => {
    const landed = await inCell(how, withPicture);

    expect(landed.cell).toBe('cell seehere');
    expect(landed.blocks).toEqual(['paragraph:cell see', 'image[pending|]', 'paragraph:here']);
    expect(landed.rows).toEqual(['table']);
  });
});

describe('text that only looks like media markup', () => {
  it.each([
    ['a code block holding a Markdown picture with a relative address', { 'text/html': '<pre><code>![logo](./logo.png)\nmore code</code></pre>', 'text/plain': '![logo](./logo.png)\nmore code' }, '![logo](./logo.png)'],
    ['a code block holding an img tag', { 'text/html': `<pre><code>&lt;img src="${U}x.png" alt="x"&gt;</code></pre>`, 'text/plain': `<img src="${U}x.png" alt="x">` }, '<img src='],
    ['inline code holding Markdown picture syntax', { 'text/html': '<p>Use the syntax <code>![alt](./a.png)</code> to embed.</p>', 'text/plain': 'Use the syntax ![alt](./a.png) to embed.' }, '![alt](./a.png)'],
    ['a code block holding a Markdown picture with no alt', { 'text/html': `<pre><code>![](${U}a.png)</code></pre>`, 'text/plain': `![](${U}a.png)` }, '![]('],
  ])('%s pastes as its words', async (_what, formats, words) => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    pasteFormats(editor, formats);
    await settled();

    expect(mediaBlocks(editor)).toBe(0);
    expect(sink.onLeftOut).not.toHaveBeenCalled();
    expect(editor.prosemirrorView!.state.doc.textContent).toContain(words);
  });
});

describe('a block opening what is pasted', () => {
  it.each([
    ['a picture', `<img src="${U}x.png">`, ['image[pending|]', 'paragraph:lead', 'paragraph:next']],
    ['a picture and words', `<img src="${U}x.png"><p>after</p>`, ['image[pending|]', 'paragraph:afterlead', 'paragraph:next']],
  ])('%s pasted at the start of a line leaves no blank line above it', async (_what, html, expected) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'next' }]);
    select(editor, positionOf(editor, 'lead', 0));

    paste(editor, html, 'x');
    await settled();

    expect(shape(editor)).toEqual(expected);
  });

  it.each([
    ['at the end of a line', 4, '<table><tr><td>a</td></tr></table>', ['paragraph:lead', 'table', 'paragraph:next']],
    ['in the middle of a line', 2, '<table><tr><td>a</td></tr></table><p>after</p>', ['paragraph:le', 'table', 'paragraph:afterad', 'paragraph:next']],
    [
      'at the end of a line, with a picture in a cell',
      4,
      `<table><tr><td><img src="${U}p.png"></td><td>Price</td></tr></table>`,
      ['paragraph:lead', 'table', 'paragraph:next'],
    ],
  ])('a table pasted %s lands beside the line', async (_where, offset, html, expected) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'next' }]);
    select(editor, positionOf(editor, 'lead', offset));

    paste(editor, html, 'a');
    await settled();

    expect(shape(editor)).toEqual(expected);
    if (_where === 'at the end of a line, with a picture in a cell') {
      expect(cellShape(editor, 1)).toEqual(['image[pending|]']);
      expect(blocksAndCells(editor)).toEqual(['paragraph:lead', [['', 'Price']], 'paragraph:next']);
    }
  });
});

describe('a block landing at the start of a line with words', () => {
  const NESTED = [{ type: 'paragraph', content: 'lead', children: [{ type: 'paragraph', content: 'kid' }] }];

  it.each([
    ['a picture', `<img src="${U}x.png">`, ['image[pending|]', 'paragraph:lead']],
    ['a table', '<table><tr><td>x</td></tr></table>', ['table', 'paragraph:lead']],
  ])('%s pasted on a line holding nested lines leaves no blank line above it', async (_what, html, expected) => {
    const { editor } = open(NESTED);
    select(editor, positionOf(editor, 'lead', 0));

    paste(editor, html, 'x');
    await settled();

    expect(shape(editor)).toEqual(expected);
    expect(editor.prosemirrorView!.state.doc.textContent).toContain('kid');
  });

  it.each([
    ['a picture and words', `<img src="${U}x.png"><p>after</p>`, ['image[pending|]', 'paragraph:afterlead']],
    ['a table and words', '<table><tr><td>t</td></tr></table><p>after</p>', ['table', 'paragraph:afterlead']],
    ['a rule and words', '<hr><p>after</p>', ['divider:', 'paragraph:afterlead']],
  ])('%s dropped at the start of a line leaves no blank line above it', async (_what, html, expected) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }]);

    drop(editor, positionOf(editor, 'lead', 0), html, 'x');
    await settled();

    expect(shape(editor)).toEqual(expected);
  });
});

describe('a medium that cannot land, in a sentence', () => {
  it.each([
    ['an http address', '<p>see <img src="http://e.example/a.png"> here</p>'],
    ['no address', `<p>see <img data-src="${U}a.png"> here</p>`],
    ['an empty video', '<p>see <video></video> here</p>'],
  ])('with %s, leaves the sentence whole, pasted or dropped, and is told', async (_what, html) => {
    for (const how of ['paste', 'drop'] as const) {
      const { editor, sink } = open([{ type: 'paragraph', content: 'abcd' }]);
      const at = positionOf(editor, 'abcd', 2);
      if (how === 'paste') {
        select(editor, at);
        paste(editor, html, 'see here');
      } else {
        drop(editor, at, html, 'see here');
      }
      await settled();

      expect(shape(editor)).toHaveLength(1);
      expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
    }
  });
});

describe('a medium that cannot land, in any container of words', () => {
  const OUT = '<img src="http://e.example/a.png">';

  it.each([
    ['a div', `<div><span>look at this </span>${OUT}<span> nice</span></div>`],
    ['a list item', `<ul><li>a${OUT}b</li></ul>`],
    ['a quote', `<blockquote>a${OUT}b</blockquote>`],
    ['a definition', `<dl><dd>a${OUT}b</dd></dl>`],
    ['preformatted text', `<pre>a${OUT}b</pre>`],
  ])('in %s, reads as the words without it, pasted or dropped, and is told', async (_what, html) => {
    for (const how of ['paste', 'drop'] as const) {
      const land = async (pasted: string): Promise<{ order: string[]; text: string; sink: Sink }> => {
        const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
        const at = caretIn(editor, 0);
        if (how === 'paste') paste(editor, pasted, 'x');
        else drop(editor, at, pasted, 'x');
        await settled();
        return { order: blockOrder(editor), text: JSON.stringify(shape(editor)), sink };
      };
      const plain = await land(html.replace(OUT, ''));
      const landed = await land(html);

      expect(landed.order).toEqual(plain.order);
      expect(landed.text).toBe(plain.text);
      expect(landed.sink.onLeftOut.mock.calls).toEqual([[1]]);
    }
  });
});

describe('a figure holding a medium and more than its caption', () => {
  it.each([
    ['words after it', `<figure><img src="${U}a.png"><p>credit</p></figure>`, ['paragraph:lead', 'image[pending|]', 'paragraph:credit']],
    [
      'words on each side and a caption',
      `<figure><p>before</p><img src="${U}a.png"><figcaption>cap</figcaption><p>after</p></figure>`,
      ['paragraph:leadbefore', 'image[pending|cap]', 'paragraph:after'],
    ],
    ['a table beside it', `<figure><img src="${U}a.png"><table><tr><td>t</td></tr></table></figure>`, ['paragraph:lead', 'image[pending|]', 'table', 'paragraph:']],
    [
      'its medium inside a heading',
      `<figure><h2>T<img src="${U}a.png"></h2><figcaption>c</figcaption></figure>`,
      ['paragraph:leadT', 'image[pending|c]', 'paragraph:'],
    ],
    [
      'its medium inside a list',
      `<figure><ul><li>a</li><li><img src="${U}a.png"></li><li>b</li></ul></figure>`,
      // The item holding only the picture keeps it as its first child.
      ['paragraph:leada', 'bulletListItem:', 'bulletListItem:b'],
    ],
    [
      'a figure of its own around the medium',
      `<figure><figure><img src="${U}a.png"><figcaption>in</figcaption></figure><figcaption>out</figcaption></figure>`,
      ['paragraph:lead', 'image[pending|in]', 'paragraph:out'],
    ],
    [
      'words in its line and a caption',
      `<figure><p>before <img src="${U}a.png"> after</p><figcaption>cap</figcaption></figure>`,
      ['paragraph:leadbefore', 'image[pending|cap]', 'paragraph:after'],
    ],
  ])('with %s keeps everything in it, in its order, pasted or dropped', async (_what, html, expected) => {
    for (const how of ['paste', 'drop'] as const) {
      const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
      const at = caretIn(editor, 0);

      if (how === 'paste') paste(editor, html, 'x');
      else drop(editor, at, html, 'x');
      await settled();

      expect(shape(editor)).toEqual(expected);
      expect(mediaBlocks(editor)).toBe(1);
    }
  });

  it.each([
    [
      'a table in a figure, a picture in its cell',
      `<figure class="table"><table><tbody><tr><td>w1<img src="${U}a.png"></td><td>w2</td></tr></tbody></table></figure>`,
      [[['w1', 'w2']]],
      ['paragraph:w1', 'image[pending|]'],
    ],
    [
      'words after a picture in a figure',
      `<figure><img src="${U}a.png"><p>body words</p></figure>`,
      [[['cell body words']]],
      ['paragraph:cell ', 'image[pending|]', 'paragraph:body words'],
    ],
  ])('%s, pasted in a table cell, keeps its words and picture in the cell', async (_what, html, expected, blocks) => {
    const land = async (pasted: string): Promise<{ cells: unknown[]; blocks: string[]; rows: string[]; media: number }> => {
      const { editor } = await openReady([TABLE]);
      caretIn(editor, 0);
      paste(editor, pasted, 'x');
      await settled();
      return { cells: blocksAndCells(editor), blocks: cellShape(editor, 0), rows: shape(editor), media: mediaBlocks(editor) };
    };
    const plain = await land(html.replace(`<img src="${U}a.png">`, ''));
    const landed = await land(html);

    expect(landed.cells).toEqual(expected);
    expect(landed.cells).toEqual(plain.cells);
    expect(plain.rows).toEqual(['table']);
    expect(landed.rows).toEqual(['table']);
    expect(landed.blocks).toEqual(blocks);
    expect(landed.media).toBe(1);
  });

  it.each([
    ['a picture that lands', `${U}a.png`, ['paragraph:lead', [['credit words', 'y']], 'paragraph:']],
    // A medium that does not land leaves its caption as words.
    ['a picture that does not land', 'http://e.example/a.png', ['paragraph:lead', [['credit wordscap', 'y']], 'paragraph:']],
  ])('in a web table cell, with %s, leaves its other words in the cell, pasted or dropped', async (_what, src, expected) => {
    const html = `<table><tr><td><figure><img src="${src}"><p>credit words</p><figcaption>cap</figcaption></figure></td><td>y</td></tr></table>`;
    for (const how of ['paste', 'drop'] as const) {
      const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
      const at = caretIn(editor, 0);

      if (how === 'paste') paste(editor, html, 'x');
      else drop(editor, at, html, 'x');
      await settled();

      expect(blocksAndCells(editor)).toEqual(expected);
      if (_what === 'a picture that lands') {
        expect(cellShape(editor, 1)).toEqual(['image[pending|cap]', 'paragraph:credit words']);
        expect(mediaBlocks(editor)).toBe(1);
      }
    }
  });

  it('with a figure of its own around a medium that does not land, keeps both captions as words', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'lead', 4));

    paste(editor, '<figure><figure><img src="http://e.example/a.png"><figcaption>in</figcaption></figure><figcaption>out</figcaption></figure>', 'x');
    await settled();

    expect(shape(editor)).toEqual(['paragraph:leadin', 'paragraph:out', 'paragraph:tail']);
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });
});

/** A document block, including the row, cell and ordinary-block children of a table. */
type ReadBlock = {
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
  children?: ReadBlock[];
};

/**
 * Reads words recursively without flattening a table's structural layers.
 * @param block - A cell or ordinary block.
 * @returns Its complete text, including nested ordinary blocks.
 */
function wordsOf(block: ReadBlock): string {
  return (block.content ?? []).map((part) => part.text ?? '').join('') + (block.children ?? []).map(wordsOf).join('');
}

/**
 * The direct ordinary blocks in one new-table cell.
 * @param editor - The editor.
 * @param table - The top-level table index.
 * @param row - The row index.
 * @param column - The cell index.
 * @returns Block types and words, or media status and caption.
 */
function cellShape(editor: Editor, table: number, row = 0, column = 0): string[] {
  const cell = (editor.document as ReadBlock[])[table]!.children![row]!.children![column]!;
  return cell.children!.map((block) => ['image', 'video', 'audio'].includes(block.type)
    ? `${block.type}[${block.props['uploadId'] !== '' ? 'pending' : String(block.props['url'])}|${String(block.props['caption'])}]`
    : `${block.type}:${(block.content ?? []).map((part) => part.text ?? '').join('')}`);
}

/**
 * The top-level blocks, each table as the words of its cells.
 * @param editor - The editor.
 * @returns Labels, tables as rows of cell words.
 */
function blocksAndCells(editor: Editor): unknown[] {
  return (editor.document as ReadBlock[]).map((block, index) =>
    block.type === 'docTable'
      ? block.children!.map((row) => row.children!.map(wordsOf))
      : shape(editor)[index],
  );
}

describe('web content dropped on a table cell', () => {
  it.each([
    ['words, a picture and a table', `<p>first</p><img src="${U}a.png"><table><tr><td>t</td></tr></table>`],
    ['a sentence split at a picture, then a table', `<p>see <img src="${U}a.png"> here</p><table><tr><td>t</td></tr></table>`],
  ])('%s is rejected without changing the body, selection or history', async (_what, html) => {
    const opened = await openReady([TABLE, { type: 'paragraph', content: 'next' }]);
    const { editor } = opened;
    laidOut(editor);
    const at = positionOf(editor, 'cell ', 5);
    select(editor, at);
    const before = pasteState(opened);

    drop(editor, at, html, 'x');
    await settled();

    expectRejected(opened, before);
  });

  it('keeps a picture in its source cell when a single dropped table expands the target', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'next' }]);

    drop(editor, positionOf(editor, 'cell ', 5), `<table><tr><td>A <img src="${U}a.png"></td><td>B</td></tr></table>`, 'x');
    await settled();

    expect(blocksAndCells(editor)).toEqual([[['A', 'B']], 'paragraph:next']);
    expect(cellShape(editor, 0)).toEqual(['paragraph:A', 'image[pending|]']);
    expect(cellShape(editor, 0, 0, 1)).toEqual(['paragraph:B']);
    expect(sink.start).toHaveBeenCalledOnce();
  });

  it('fills the cells from the one it was dropped in, as a table pasted there does', async () => {
    const { editor, sink } = await openReady([TWO_CELLS, { type: 'paragraph', content: 'next' }]);

    drop(editor, positionOf(editor, 'c1', 1), `<table><tr><td>A <img src="${U}a.png"></td><td>B</td></tr></table>`, 'A B');
    await settled();

    expect(blocksAndCells(editor)).toEqual([[['A', 'B']], 'paragraph:next']);
    expect(cellShape(editor, 0)).toEqual(['paragraph:A', 'image[pending|]']);
    expect(cellShape(editor, 0, 0, 1)).toEqual(['paragraph:B']);
    expect(sink.start).toHaveBeenCalledOnce();
  });
});

describe('web content dropped with a list holding pictures', () => {
  it.each([
    ['icons in list items', `<ul><li><span><img src="${U}fr.png"></span>&nbsp;<a>France</a></li><li><span><img src="${U}de.png"></span>&nbsp;<a>Germany</a></li></ul>`],
    ['a list between paragraphs', `<p>intro</p><ul><li>a <img src="${U}a.png"></li><li>b</li></ul><p>outro</p>`],
    ['a picture opening a list item', `<ul><li><img src="${U}a.png"> one</li><li>two</li></ul>`],
  ])('with %s lands as the same paste does', async (_what, html) => {
    const land = async (how: 'paste' | 'drop'): Promise<{ order: string[]; text: string; started: number }> => {
      const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
      const at = positionOf(editor, 'lead', 4);
      select(editor, at);
      if (how === 'paste') paste(editor, html, 'x');
      else drop(editor, at, html, 'x');
      await settled();
      return { order: blockOrder(editor), text: editor.prosemirrorView!.state.doc.textContent, started: sink.start.mock.calls.length };
    };

    const dropped = await land('drop');

    expect(dropped).toEqual(await land('paste'));
    expect(dropped.started).toBeGreaterThan(0);
  });
});

describe('web content dropped at the end of the last table cell', () => {
  it.each([
    ['words', '<p>words</p>', ['paragraph:cell words']],
    ['words and a picture', `<p>words</p><img src="${U}a.png">`, ['paragraph:cell words', 'image[pending|]', 'paragraph:']],
  ])('%s land as ordinary blocks in the cell', async (_what, html, blocks) => {
    const { editor } = await openReady([TABLE]);

    drop(editor, positionOf(editor, 'cell ', 5), html, 'words');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell words');
    expect(cellShape(editor, 0)).toEqual(blocks);
    expect(shape(editor)).toEqual(['table']);
  });
});

describe('what decides a medium lands, read before a line is split', () => {
  it('a picture given only by srcset splits its sentence', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, `<p>see <img srcset="${U}s.png 2x"> here</p>`, 'see here');
    await settled();

    expect(shape(editor).map((label) => label.trim())).toEqual(['paragraph:leadsee', 'image[pending|]', 'paragraph:here']);
  });
});

describe('the words a table cell takes', () => {
  it('keep the caption and ordinary media blocks of a figure of several pictures', async () => {
    const { editor } = await openReady([TABLE]);
    caretIn(editor, 0);

    paste(editor, `<figure><img src="${U}1.png"><img src="${U}2.png"><figcaption>both</figcaption></figure>`, 'both');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell both');
    expect(cellShape(editor, 0)).toEqual(['paragraph:cell ', 'image[pending|]', 'image[pending|]', 'paragraph:both']);
    expect(shape(editor)).toEqual(['table']);
  });

  it('rejects prose beside a table whose span runs past its rows, with or without a picture', async () => {
    const TALL = '<table><tr><td rowspan="3">tall</td></tr></table>';
    for (const html of [`<p>w</p>${TALL}`, `<p>w</p><img src="${U}a.png">${TALL}`]) {
      const opened = await openReady([TABLE]);
      caretIn(opened.editor, 0);
      const before = pasteState(opened);

      paste(opened.editor, html, 'w tall');
      await settled();

      expectRejected(opened, before);
    }
  });
});

/**
 * Gives the body a box the drop falls inside, as a browser lays it out:
 * BlockNote's side menu takes a drop outside that box for one beside the
 * editor and collapses the selection after it lands.
 * @param editor - The editor.
 */
function laidOut(editor: Editor): void {
  const box = { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: (): unknown => ({}) } as DOMRect;
  const view = editor.prosemirrorView!;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
}

describe('a drop put in a cell or under a line by the body', () => {
  it('rejects mixed table content dropped in a cell without moving the original caret', async () => {
    const opened = await openReady([{ type: 'paragraph', content: 'caret' }, TABLE, { type: 'paragraph', content: 'next' }]);
    const { editor } = opened;
    laidOut(editor);
    select(editor, 2);
    const before = pasteState(opened);

    drop(editor, positionOf(editor, 'cell ', 5), `<p>first</p><img src="${U}a.png"><table><tr><td>t</td></tr></table>`, 'x');
    await settled();

    expectRejected(opened, before);
  });

  it.each([
    ['under the line it was dropped below', [{ type: 'paragraph', content: 'lead' }], (editor: Editor): number => editor.prosemirrorView!.state.doc.content.size - 2, `<p>dropped</p><img src="${U}a.png">`, 'dropped'],
  ])('%s selects what it put in', async (_where, blocks, at, html, words) => {
    const { editor } = open([{ type: 'paragraph', content: 'caret' }, ...blocks]);
    laidOut(editor);
    select(editor, 2);

    drop(editor, at(editor), html, 'x');
    await settled();

    const { from, to } = editor.prosemirrorView!.state.selection;
    expect(editor.prosemirrorView!.state.doc.textBetween(from, to, ' ')).toContain(words);
  });

  it('outside every line opens a line there for what it puts in', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'two' }]);

    drop(editor, 0, `<p>a <img src="${U}a.png"> b</p>`, 'x');
    await settled();

    expect(shape(editor)).toEqual(['paragraph:a', 'image[pending|]', 'paragraph:b', 'paragraph:one', 'paragraph:two']);
  });
});

describe('a drop whose media all fail to land', () => {
  const OUT = '<img src="http://e.example/a.png">';

  it.each([
    ['words in a cell', [TABLE, { type: 'paragraph', content: 'next' }], 'cell ', 2, `<p>w</p>${OUT}`],
    ['words and a table in a cell', [TABLE, { type: 'paragraph', content: 'next' }], 'cell ', 2, `<p>w</p>${OUT}<table><tr><td>t</td></tr></table>`],
  ])('with %s follows the cell contract with or without that medium', async (what, blocks, words, offset, html) => {
    const land = async (dropped: string): Promise<{ blocks: unknown[]; told: unknown[] }> => {
      const opened = await openReady(blocks as unknown[]);
      const { editor, sink } = opened;
      laidOut(editor);
      const at = positionOf(editor, words, offset);
      select(editor, at);
      const before = pasteState(opened);
      drop(editor, at, dropped, 'x');
      await settled();
      if (what === 'words and a table in a cell') expectRejected(opened, before);
      return { blocks: blocksAndCells(editor), told: sink.onLeftOut.mock.calls };
    };

    const out = await land(html);
    const without = await land(html.replace(OUT, ''));

    expect(out.blocks).toEqual(without.blocks);
    expect(out.told).toEqual(what === 'words and a table in a cell' ? [] : [[1]]);
  });

  it('in a line lands as the same content pasted there, the line whole, and is told once', async () => {
    const html = `<div><p>x ${OUT} y</p><blockquote><p>q</p></blockquote></div>`;
    const land = async (how: 'paste' | 'drop'): Promise<{ blocks: string[]; told: unknown[] }> => {
      const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
      const at = positionOf(editor, 'lead', 4);
      select(editor, at);
      if (how === 'paste') paste(editor, html, 'x');
      else drop(editor, at, html, 'x');
      await settled();
      return { blocks: shape(editor), told: sink.onLeftOut.mock.calls };
    };

    const dropped = await land('drop');

    expect(dropped).toEqual(await land('paste'));
    expect(dropped.told).toEqual([[1]]);
  });
});

describe('a figure whose medium sits in a wrapper beside a rule', () => {
  it('keeps the rule', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, `<figure><div><hr><img src="${U}a.png"></div><figcaption>c</figcaption></figure>`, 'x');
    await settled();

    expect(shape(editor)).toEqual(['paragraph:lead', 'divider:', 'image[pending|c]', 'paragraph:']);
  });
});

describe('content of another body dropped on a table cell', () => {
  it('rejects its mixed words, picture and table without changing the target', async () => {
    const source = await openReady([
      { type: 'paragraph', content: 'first' },
      { type: 'image', props: { url: `${OURS}a.png` } },
      tableBlock({ rows: [{ cells: ['t'] }] }),
    ]);
    const html = source.editor.blocksToFullHTML(source.editor.document as never);
    const opened = await openReady([TABLE, { type: 'paragraph', content: 'next' }]);
    const { editor } = opened;
    laidOut(editor);
    const at = positionOf(editor, 'cell ', 5);
    select(editor, at);
    const before = pasteState(opened);

    drop(editor, at, html, 'x');
    await settled();

    expectRejected(opened, before);
  });
});

describe('a drop read where it lands, wherever the caret was', () => {
  it.each([
    ['words and a medium', `<p>w1</p><p>w2</p><img src="${U}a.png">`],
    ['a medium between words', `<p>w1</p><img src="${U}a.png"><p>w2</p>`],
    ['words alone', '<p>w1</p><p>w2</p>'],
    ['a list with a medium', `<ul><li>a</li><li>b <img src="${U}a.png"></li></ul>`],
  ])('on a table cell, %s land as the same paste there', async (_what, html) => {
    const land = async (how: 'paste' | 'drop'): Promise<{ blocks: unknown[]; order: string[] }> => {
      const { editor } = await openReady([{ type: 'paragraph', content: 'caret' }, TABLE, { type: 'paragraph', content: 'next' }]);
      laidOut(editor);
      const at = positionOf(editor, 'cell ', 2);
      select(editor, how === 'paste' ? at : 2);
      if (how === 'paste') paste(editor, html, 'x');
      else drop(editor, at, html, 'x');
      await settled();
      expect(shape(editor)).toEqual(['paragraph:caret', 'table', 'paragraph:next']);
      expect(mediaBlocks(editor)).toBe(_what === 'words alone' ? 0 : 1);
      return { blocks: blocksAndCells(editor), order: blockOrder(editor) };
    };

    expect(await land('drop')).toEqual(await land('paste'));
  });

  it('on a line outside the table the caret is in, lands its medium', async () => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'next' }]);
    laidOut(editor);
    select(editor, positionOf(editor, 'cell ', 2));

    drop(editor, positionOf(editor, 'lead', 4), `<p>a</p><img src="${U}a.png"><p>b</p>`, 'x');
    await settled();

    expect(blocksAndCells(editor)).toEqual([[['cell ']], 'paragraph:leada', 'image[pending|]', 'paragraph:b', 'paragraph:next']);
    expect(sink.start).toHaveBeenCalledTimes(1);
  });
});

describe('a table holding no cell', () => {
  it.each(['paste', 'drop'] as const)('is no table: a %s on a cell keeps its medium in the cell', async (how) => {
    const { editor, sink } = await openReady([TABLE, { type: 'paragraph', content: 'next' }]);
    laidOut(editor);
    const at = positionOf(editor, 'cell ', 2);
    select(editor, at);
    const html = `<table><tr></tr></table><img src="${U}a.png">`;

    if (how === 'paste') paste(editor, html, 'x');
    else drop(editor, at, html, 'x');
    await settled();

    expect(blocksAndCells(editor)).toEqual([[['cell ']], 'paragraph:next']);
    expect(cellShape(editor, 0)).toEqual(['paragraph:ce', 'image[pending|]', 'paragraph:ll ']);
    expect(sink.start).toHaveBeenCalledOnce();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('a medium in a heading beside a rule', () => {
  it('leaves no empty heading: a heading reads no rule', async () => {
    const land = async (html: string): Promise<string[]> => {
      const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: '' }]);
      caretIn(editor, 1);
      paste(editor, html, 'x');
      await settled();
      const blocks = shape(editor);
      unmountAll();
      return blocks;
    };

    expect(await land(`<h2>Title <img src="${U}a.png"> <hr></h2>`)).toEqual(['paragraph:lead', 'heading:Title', 'image[pending|]', 'paragraph:']);
    expect(await land(`<h2><span>Title <img src="${U}a.png"> <hr></span></h2>`)).toEqual(['paragraph:lead', 'heading:Title', 'image[pending|]', 'paragraph:']);
  });

  it('keeps a table a paragraph reads after its medium', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: '' }]);
    caretIn(editor, 1);

    paste(editor, `<p>x <img src="${U}a.png"> <table><tr><td></td></tr></table></p>`, 'x');
    await settled();

    // The empty line it was pasted on stays under what went in above it.
    expect(blocksAndCells(editor)).toEqual(['paragraph:lead', 'paragraph:x', 'image[pending|]', [['']], 'paragraph:']);
  });
});

describe('words copied out of a table cell', () => {
  /**
   * Copies a range of a body the way the browser's copy does.
   * @param editor - The editor.
   * @param from - Where the range starts.
   * @param to - Where it ends.
   * @returns The clipboard formats written.
   */
  function copied(editor: Editor, from: number, to: number): Record<string, string> {
    const data: Record<string, string> = {};
    select(editor, from, to);
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, value: string) => (data[type] = value), clearData: () => undefined, getData: (type: string) => data[type] ?? '' },
    });
    editor.prosemirrorView!.dom.dispatchEvent(event);
    return data;
  }

  it.each([
    ['a paragraph', { type: 'paragraph', content: 'lead' }, 'paragraph:leadhello'],
    ['a heading', { type: 'heading', content: 'lead' }, 'heading:leadhello'],
  ])('join %s they are pasted into', async (_where, block, joined) => {
    const source = await openReady([tableBlock({ rows: [{ cells: ['hello world'] }] })]);
    const from = positionOf(source.editor, 'hello world', 0);
    const formats = copied(source.editor, from, from + 5);
    const { editor } = await openReady([TABLE, block]);
    select(editor, positionOf(editor, 'lead', 4));

    pasteFormats(editor, formats);
    await settled();

    expect(blocksAndCells(editor)).toEqual([[['cell ']], joined]);
  });
});
