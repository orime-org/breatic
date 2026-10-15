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
  caretIn,
  drop,
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
  ])('keeps no blank line from %s', async (_what, html) => {
    const { editor } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);

    paste(editor, html, 'see here');
    await settled();

    expect(shape(editor).map((label) => label.trim())).toEqual(['paragraph:leadsee', 'image[pending|]', 'paragraph:here']);
  });
});
