// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How web content with media is read (inner#1351 + inner#1390 design §5.4.2,
 * A3, A5): each medium is swapped for a text marker, BlockNote reads the
 * rest as it reads words, and the media go back where their markers landed.
 * Every case pastes on an empty line with `<p>end</p>` closing the HTML, so
 * the body is exactly the blocks read followed by `end` (§5.4.3 empty line).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { OURS, caretIn, open, paste, positionOf, select, settled, unmountAll, type Editor, type Sink } from './paste-harness';

afterEach(unmountAll);

const A = `${OURS}a.png`;
const B = `${OURS}b.png`;
const NOT_FETCHABLE = 'http://e.example/a.png';

type Block = {
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
};

/**
 * The text of a block's inline content.
 * @param block - The block.
 * @returns Its words.
 */
function words(block: Block): string {
  const text = (items: readonly { text?: string; content?: unknown }[]): string =>
    items.map((c) => c.text ?? (Array.isArray(c.content) ? text(c.content as { text?: string }[]) : '')).join('');
  return Array.isArray(block.content) ? text(block.content as { text?: string }[]) : '';
}

/**
 * Every block as a label, nested ones indented under their parent.
 * @param editor - The editor.
 * @returns `type[#level][q]:words` for text blocks, `type(url|name|caption)[q]` for media, `table` for tables.
 */
function tree(editor: Editor): string[] {
  const label = (block: Block): string => {
    const quoted = block.props['quoted'] === true ? '[q]' : '';
    if (['image', 'video', 'audio'].includes(block.type)) {
      const url = block.props['uploadId'] !== '' && block.props['uploadId'] !== undefined ? 'pending' : String(block.props['url']);
      return `${block.type}(${url}|${String(block.props['name'])}|${String(block.props['caption'])})${quoted}`;
    }
    if (block.type === 'table') return `table${quoted}`;
    const level = block.type === 'heading' ? `#${String(block.props['level'])}` : '';
    return `${block.type}${level}${quoted}:${words(block)}`;
  };
  const walk = (blocks: Block[], depth: number): string[] =>
    blocks.flatMap((block) => [`${'  '.repeat(depth)}${label(block)}`, ...walk(block.children ?? [], depth + 1)]);
  return walk(editor.document, 0);
}

/**
 * How many media the reader was told were left out.
 * @param sink - The sink.
 * @returns The count.
 */
function told(sink: Sink): number {
  return sink.onLeftOut.mock.calls.reduce((sum, call) => sum + (call[0] as number), 0);
}

/**
 * Pastes web content on an empty line, closed by a paragraph `end`.
 * @param html - The content.
 * @returns The editor and its sink, after the paste settles.
 */
async function read(html: string): Promise<{ editor: Editor; sink: Sink }> {
  const { editor, sink } = open([{ type: 'paragraph' }]);
  caretIn(editor, 0);
  paste(editor, `${html}<p>end</p>`, 'words');
  await settled();
  return { editor, sink };
}

describe('a medium inside a line of words splits that line where it stands', () => {
  it.each([
    ['a paragraph', `<p>ab <img src="${A}"> cd</p>`, ['paragraph:ab', `image(${A}||)`, 'paragraph:cd']],
    ['a heading, both halves staying headings', `<h2>ab <img src="${A}"> cd</h2>`, ['heading#2:ab', `image(${A}||)`, 'heading#2:cd']],
    ['a link', `<p><a href="https://x.example/">ab <img src="${A}"> cd</a></p>`, ['paragraph:ab', `image(${A}||)`, 'paragraph:cd']],
    // BlockNote reads a web quote's lines unquoted, and the medium follows its line.
    ['a quote, the medium following its line', `<blockquote><p>ab <img src="${A}"> cd</p></blockquote>`, ['paragraph:ab', `image(${A}||)`, 'paragraph:cd']],
    ['line breaks on both sides of it', `<p>ab<br><img src="${A}"><br>cd</p>`, ['paragraph:ab', `image(${A}||)`, 'paragraph:cd']],
    ['a line it opens, keeping no empty half', `<p><img src="${A}"> cd</p>`, [`image(${A}||)`, 'paragraph:cd']],
  ])('in %s', async (_name, html, blocks) => {
    const { editor } = await read(html);
    expect(tree(editor)).toEqual([...blocks, 'paragraph:end']);
  });
});

describe('a medium inside a list item', () => {
  it('splits the item: the front stays its words, the medium and the back lead its children', async () => {
    const { editor } = await read(`<ul><li>one <img src="${A}"> two<ul><li>kid</li></ul></li></ul>`);
    expect(tree(editor)).toEqual([
      'bulletListItem:one',
      `  image(${A}||)`,
      '  paragraph:two',
      '  bulletListItem:kid',
      'paragraph:end',
    ]);
  });

  it('leaves a numbered list unbroken', async () => {
    const { editor } = await read(`<ol><li>one <img src="${A}"> two</li><li>three</li></ol>`);
    expect(tree(editor)).toEqual([
      'numberedListItem:one',
      `  image(${A}||)`,
      '  paragraph:two',
      'numberedListItem:three',
      'paragraph:end',
    ]);
  });
});

describe('a medium inside a table', () => {
  it('in a cell lands under that table', async () => {
    const { editor } = await read(`<table><tr><td>x <img src="${A}"></td><td>y</td></tr></table>`);
    expect(tree(editor)).toEqual(['table', `image(${A}||)`, 'paragraph:end']);
  });

  it.each([
    ['in the middle of its words, one space between them', `a <img src="${A}"> b`, 'a b'],
    ['at the start of its words', `<img src="${A}"> x`, 'x'],
    ['at the end of its words', `x <img src="${A}">`, 'x'],
    ['between words with no space', `a<img src="${A}">b`, 'ab'],
    ['two of them, the space before the first', `a <img src="${A}"><img src="${A}">b`, 'a b'],
  ])('%s leaves the cell its words as they read without it', async (_where, cell, words) => {
    const { editor } = await read(`<table><tr><td>${cell}</td></tr></table>`);
    const table = (editor.document as { content: { rows: { cells: { content: { text?: string }[] }[] }[] } }[])[0];
    expect(table.content.rows[0].cells[0].content.map((c) => c.text ?? '').join('')).toBe(words);
  });

  it('in the caption lands under that table', async () => {
    const { editor } = await read(`<table><caption>cap <img src="${A}"></caption><tr><td>x</td></tr></table>`);
    expect(tree(editor)).toEqual(['table', `image(${A}||)`, 'paragraph:end']);
  });
});

describe('a figure', () => {
  it('with one medium makes its caption the caption and its alt the name', async () => {
    const { editor } = await read(`<figure><img src="${A}" alt="Alt"><figcaption>Cap</figcaption></figure>`);
    expect(tree(editor)).toEqual([`image(${A}|Alt|Cap)`, 'paragraph:end']);
  });

  it('with several media keeps its caption as words', async () => {
    const { editor } = await read(`<figure><img src="${A}"><img src="${B}"><figcaption>Both</figcaption></figure>`);
    expect(tree(editor)).toEqual([`image(${A}||)`, `image(${B}||)`, 'paragraph:Both', 'paragraph:end']);
  });

  it('whose only medium cannot land keeps its caption as words and tells it', async () => {
    const { editor, sink } = await read(`<figure><img src="${NOT_FETCHABLE}"><figcaption>Cap</figcaption></figure>`);
    expect(tree(editor)).toEqual(['paragraph:Cap', 'paragraph:end']);
    expect(told(sink)).toBe(1);
  });

  it('counts only the media that land when giving its caption', async () => {
    const { editor, sink } = await read(
      `<figure><img src="${NOT_FETCHABLE}"><img src="${A}"><figcaption>Cap</figcaption></figure>`,
    );
    expect(tree(editor)).toEqual([`image(${A}||Cap)`, 'paragraph:end']);
    expect(told(sink)).toBe(1);
  });
});

describe('a medium that cannot land', () => {
  it('leaves its line read whole, and is told', async () => {
    const { editor, sink } = await read(`<p>ab <img src="${NOT_FETCHABLE}"> cd</p>`);
    expect(tree(editor)).toEqual(['paragraph:ab cd', 'paragraph:end']);
    expect(told(sink)).toBe(1);
  });
});

describe('a video or an audio given only by its sources', () => {
  it.each([
    ['video', `<video><source src="${NOT_FETCHABLE}"><source src="${OURS}v.mp4"></video>`, `video(${OURS}v.mp4||)`],
    ['audio', `<audio><source src="${OURS}s.mp3"><source src="${OURS}t.mp3"></audio>`, `audio(${OURS}s.mp3||)`],
  ])('takes the first source that lands, for %s', async (_kind, html, block) => {
    const { editor, sink } = await read(html);
    expect(tree(editor)).toEqual([block, 'paragraph:end']);
    expect(told(sink)).toBe(0);
  });
});

describe('an empty line written as a line break, beside a medium', () => {
  it('is an empty line: nothing joins the words after the caret', async () => {
    const { editor } = open([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 2));
    paste(editor, `<p><img src="${A}"></p><p><br></p>`, '');
    await settled();
    expect(tree(editor)).toEqual(['paragraph:ab', `image(${A}||)`, 'paragraph:cd']);
  });

  it('puts nothing in a code block', async () => {
    const { editor } = open([{ type: 'codeBlock', content: 'x = 1' }, { type: 'paragraph', content: 'after' }]);
    caretIn(editor, 0);
    paste(editor, `<p><img src="${A}"></p><p><br></p>`, '');
    await settled();
    expect(tree(editor)).toEqual(['codeBlock:x = 1', `image(${A}||)`, 'paragraph:after']);
  });

  it('of two, leaves one: the first still draws its line', async () => {
    const { editor } = await read(`<p>a<br><br></p><img src="${A}">`);
    expect(tree(editor)).toEqual(['paragraph:a\n', `image(${A}||)`, 'paragraph:end']);
  });

  it('ending code stays: code keeps every line break', async () => {
    const { editor } = await read(`<pre><code>a\n\n</code></pre><img src="${A}">`);
    expect(tree(editor)).toEqual(['codeBlock:a\n\n', `image(${A}||)`, 'paragraph:end']);
  });

  it('keeps a break between words', async () => {
    const { tree: lines } = { tree: tree((await read(`<p>a<br>b<br></p><img src="${A}">`)).editor) };
    expect(lines).toEqual(['paragraph:a\nb', `image(${A}||)`, 'paragraph:end']);
  });
});

describe('a medium inside a code block', () => {
  it('on a line of its own leaves no empty line and no line of spaces', async () => {
    const { editor } = await read(`<pre><code>line1\n<img src="${A}">\n  line2</code></pre>`);
    expect(tree(editor)).toEqual(['codeBlock:line1', `image(${A}||)`, 'codeBlock:  line2', 'paragraph:end']);
  });

  it('indented on a line of its own takes the indent out with that line', async () => {
    const { editor } = await read(`<pre><code>line1\n    <img src="${A}">\nline2</code></pre>`);
    expect(tree(editor)).toEqual(['codeBlock:line1', `image(${A}||)`, 'codeBlock:line2', 'paragraph:end']);
  });

  it('in the middle of a line keeps every space around it', async () => {
    const { editor } = await read(`<pre><code>a = 1 <img src="${A}"> b\n  c</code></pre>`);
    expect(tree(editor)).toEqual(['codeBlock:a = 1 ', `image(${A}||)`, 'codeBlock: b\n  c', 'paragraph:end']);
  });
});

describe('every medium a paste carries', () => {
  it('ends as a block in the body or is told as left out', async () => {
    const { editor, sink } = await read(
      [
        `<p>a <img src="${A}"> b</p>`,
        `<p><img src="${NOT_FETCHABLE}"></p>`,
        `<ul><li>c <img src="${B}"></li></ul>`,
        `<figure><img src="${NOT_FETCHABLE}"><figcaption>f</figcaption></figure>`,
        `<table><tr><td><img src="${OURS}t.png"></td></tr></table>`,
      ].join(''),
    );
    let blocks = 0;
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (['image', 'video', 'audio'].includes(node.type.name)) blocks += 1;
      return true;
    });
    expect(blocks).toBe(3);
    expect(told(sink)).toBe(2);
  });
});

describe('a medium ending a line with nested lines', () => {
  it('leaves the nested lines under the front half', async () => {
    const { editor: source } = open([{ type: 'paragraph' }]);
    const html = source
      .blocksToFullHTML([{ type: 'paragraph', content: 'front', children: [{ type: 'paragraph', content: 'kid' }] }] as never)
      .replace('front', `front <img src="${A}">`);
    const { editor } = await read(html);
    expect(tree(editor)).toEqual(['paragraph:front', '  paragraph:kid', `image(${A}||)`, 'paragraph:end']);
  });
});
