// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a paste of web content reads, and that every medium it carries lands
 * or is told as left out (inner#1351 + inner#1390 design §5.4, A3, A5): the
 * format read is the one BlockNote would read, the media in it land where
 * they stand in the line, and none goes without the reader knowing.
 */

import { describe, it, expect, afterEach } from 'vitest';

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

afterEach(unmountAll);

const U = 'https://e.example/';

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
 * How many media the reader was told were left out.
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

  it.each(HTML_CASES)('%s, pasted in a table cell', async (_what, html, text, media) => {
    const { editor, sink } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, html, text);
    await settled();

    expect(mediaBlocks(editor) + told(sink)).toBe(media);
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
});

describe('web content with a picture in a sentence, landing in a table cell', () => {
  /**
   * Pastes or drops one clipboard into a one-cell table.
   * @param how - Paste or drop.
   * @param formats - The clipboard.
   * @returns The cell's words and the labels of the top-level blocks.
   */
  async function inCell(how: 'paste' | 'drop', formats: Record<string, string>): Promise<{ cell: string; rows: string[] }> {
    const { editor } = open([TABLE]);
    const at = caretIn(editor, 0);
    if (how === 'paste') pasteFormats(editor, formats);
    else drop(editor, at, formats['text/html'] ?? '', formats['text/plain'] ?? '');
    await settled();
    return { cell: firstCell(editor, 0), rows: shape(editor) };
  }

  it.each([
    ['pasted as HTML', 'paste', { 'text/html': `<p>see <img src="${U}i.png"> here</p>`, 'text/plain': 'see here' }, { 'text/html': '<p>see  here</p>', 'text/plain': 'see here' }],
    ['pasted as Markdown', 'paste', { 'text/markdown': `see ![x](${U}i.png) here` }, { 'text/markdown': 'see  here' }],
    ['dropped', 'drop', { 'text/html': `<p>see <img src="${U}i.png"> here</p>`, 'text/plain': 'see here' }, { 'text/html': '<p>see  here</p>', 'text/plain': 'see here' }],
  ] as const)('%s, puts the words in the cell as without the picture and the picture under the table', async (_what, how, withPicture, without) => {
    const plain = await inCell(how, without);
    const landed = await inCell(how, withPicture);

    expect(landed.cell).toBe(plain.cell);
    expect(landed.rows).toEqual(['table', 'image[pending|]']);
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
      ['paragraph:lead', 'table', 'image[pending|]', 'paragraph:next'],
    ],
  ])('a table pasted %s lands beside the line', async (_where, offset, html, expected) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'next' }]);
    select(editor, positionOf(editor, 'lead', offset));

    paste(editor, html, 'a');
    await settled();

    expect(shape(editor)).toEqual(expected);
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
    ['a table beside it', `<figure><img src="${U}a.png"><table><tr><td>t</td></tr></table></figure>`, ['paragraph:lead', 'image[pending|]', 'table']],
    [
      'its medium inside a heading',
      `<figure><h2>T<img src="${U}a.png"></h2><figcaption>c</figcaption></figure>`,
      ['paragraph:leadT', 'image[pending|c]'],
    ],
    [
      'its medium inside a list',
      `<figure><ul><li>a</li><li><img src="${U}a.png"></li><li>b</li></ul></figure>`,
      ['paragraph:leada', 'image[pending|]', 'bulletListItem:b'],
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
    }
  });

  it.each([
    ['a table in a figure, a picture in its cell', `<figure class="table"><table><tbody><tr><td>w1<img src="${U}a.png"></td><td>w2</td></tr></tbody></table></figure>`],
    ['words after a picture in a figure', `<figure><img src="${U}a.png"><p>body words</p></figure>`],
  ])('%s, pasted in a table cell, gives the cell the words it takes without the picture', async (_what, html) => {
    const land = async (pasted: string): Promise<{ cells: string; rows: string[] }> => {
      const { editor } = open([TABLE]);
      caretIn(editor, 0);
      paste(editor, pasted, 'x');
      await settled();
      const table = (editor.document as { content: { rows: { cells: { content: { text?: string }[] }[] }[] } }[])[0]!;
      return { cells: JSON.stringify(table.content.rows.map((row) => row.cells.map((cell) => cell.content.map((c) => c.text ?? '').join('')))), rows: shape(editor) };
    };
    const plain = await land(html.replace(`<img src="${U}a.png">`, ''));
    const landed = await land(html);

    expect(landed.cells).toBe(plain.cells);
    expect(landed.rows).toEqual([...plain.rows.slice(0, 1), 'image[pending|]', ...plain.rows.slice(1)]);
  });

  it.each([
    ['a picture that lands', `${U}a.png`, ['paragraph:lead', [['credit words', 'y']], 'image[pending|cap]']],
    ['a picture that does not land', 'http://e.example/a.png', ['paragraph:lead', [['credit words', 'y']]]],
  ])('in a web table cell, with %s, leaves its other words in the cell, pasted or dropped', async (_what, src, expected) => {
    const html = `<table><tr><td><figure><img src="${src}"><p>credit words</p><figcaption>cap</figcaption></figure></td><td>y</td></tr></table>`;
    for (const how of ['paste', 'drop'] as const) {
      const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
      const at = caretIn(editor, 0);

      if (how === 'paste') paste(editor, html, 'x');
      else drop(editor, at, html, 'x');
      await settled();

      expect(blocksAndCells(editor)).toEqual(expected);
    }
  });

  it('with a figure of its own around a medium that does not land, takes that caption out with it', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'lead', 4));

    paste(editor, '<figure><figure><img src="http://e.example/a.png"><figcaption>in</figcaption></figure><figcaption>out</figcaption></figure>', 'x');
    await settled();

    expect(shape(editor)).toEqual(['paragraph:leadout', 'paragraph:tail']);
    expect(sink.onLeftOut.mock.calls).toEqual([[1]]);
  });
});

/**
 * The top-level blocks, each table as the words of its cells.
 * @param editor - The editor.
 * @returns Labels, tables as rows of cell words.
 */
function blocksAndCells(editor: Editor): unknown[] {
  type Row = { cells: { content: { text?: string }[] }[] };
  return (editor.document as { type: string; content?: { rows?: Row[] } }[]).map((block, index) =>
    block.type === 'table'
      ? block.content!.rows!.map((row) => row.cells.map((cell) => cell.content.map((c) => c.text ?? '').join('')))
      : shape(editor)[index],
  );
}

describe('web content a cell cannot take, dropped on a table cell', () => {
  it.each([
    [
      'words, a picture and a table',
      `<p>first</p><img src="${U}a.png"><table><tr><td>t</td></tr></table>`,
      [[['cell ']], 'paragraph:first', 'image[pending|]', [['t']], 'paragraph:next'],
    ],
    [
      'a sentence split at a picture, then a table',
      `<p>see <img src="${U}a.png"> here</p><table><tr><td>t</td></tr></table>`,
      [[['cell ']], 'paragraph:see', 'image[pending|]', 'paragraph:here', [['t']], 'paragraph:next'],
    ],
    [
      'a table with a picture in a cell',
      `<table><tr><td>A <img src="${U}a.png"></td><td>B</td></tr></table>`,
      [[['cell ']], [['A', 'B']], 'image[pending|]', 'paragraph:next'],
    ],
  ])('%s lands whole under that table, in its order', async (_what, html, expected) => {
    const { editor } = open([TABLE, { type: 'paragraph', content: 'next' }]);

    drop(editor, positionOf(editor, 'cell ', 5), html, 'x');
    await settled();

    expect(blocksAndCells(editor)).toEqual(expected);
  });

  it('leaves the table it was dropped in the middle of whole', async () => {
    const { editor } = open([TWO_CELLS, { type: 'paragraph', content: 'next' }]);

    drop(editor, positionOf(editor, 'c1', 1), `<table><tr><td>A <img src="${U}a.png"></td><td>B</td></tr></table>`, 'A B');
    await settled();

    expect(blocksAndCells(editor)).toEqual([[['c1', 'c2']], [['A', 'B']], 'image[pending|]', 'paragraph:next']);
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
    ['words', '<p>words</p>', ['table']],
    ['words and a picture', `<p>words</p><img src="${U}a.png">`, ['table', 'image[pending|]']],
  ])('%s land, the words in the cell', async (_what, html, rows) => {
    const { editor } = open([TABLE]);

    drop(editor, positionOf(editor, 'cell ', 5), html, 'words');
    await settled();

    expect(firstCell(editor, 0)).toBe('cell words');
    expect(shape(editor)).toEqual(rows);
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
  it('keep the caption of a figure of several pictures', async () => {
    const { editor } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, `<figure><img src="${U}1.png"><img src="${U}2.png"><figcaption>both</figcaption></figure>`, 'both');
    await settled();

    expect(firstCell(editor, 0)).toContain('both');
    expect(shape(editor)).toEqual(['table', 'image[pending|]', 'image[pending|]']);
  });

  it('come from a table whose span runs past its rows as they do without the picture', async () => {
    const TALL = '<table><tr><td rowspan="3">tall</td></tr></table>';
    const plain = open([TABLE]);
    caretIn(plain.editor, 0);
    paste(plain.editor, `<p>w</p>${TALL}`, 'w tall');
    await settled();
    const { editor } = open([TABLE]);
    caretIn(editor, 0);

    paste(editor, `<p>w</p><img src="${U}a.png">${TALL}`, 'w tall');
    await settled();

    const expected = shape(plain.editor);
    expected.splice(1, 0, 'image[pending|]');
    expect(shape(editor)).toEqual(expected);
    expect(firstCell(editor, 0)).toBe(firstCell(plain.editor, 0));
  });
});
