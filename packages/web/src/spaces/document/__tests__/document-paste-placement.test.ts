// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where content holding media lands (inner#1351 + inner#1390 design §5.4.3,
 * A1, A2, A5): the target settled from the selection first, then one set of
 * placement rules for web content, the body's own content and the canvas
 * alike, and the caret after what was put.
 */

import { tableBlock } from './table-fixtures';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { NodeSelection } from '@tiptap/pm/state';

import { serializeClipboard, type ClipboardNode } from '@web/spaces/canvas/node-clipboard';

import { OURS, TABLE, caretIn, open as openBody, paste, pasteFormats, positionOf, select, settled, unmountAll, type Editor } from './paste-harness';

afterEach(unmountAll);

type Block = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

/**
 * Opens a body that also takes canvas pastes.
 * @param blocks - The document.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  return openBody(blocks, { onCanvasPaste: { start: vi.fn(), notPasted: vi.fn() } }).editor;
}

/**
 * Every block as a label, nested ones indented under their parent.
 * @param editor - The editor.
 * @returns `type[#level][q]:words` for text blocks, `image(url or pending)[q]` for media, `table` for tables.
 */
function lines(editor: Editor): string[] {
  const label = (block: Block): string => {
    const quoted = block.props['quoted'] === true ? '[q]' : '';
    if (['image', 'video', 'audio'].includes(block.type)) {
      const pending = block.props['uploadId'] !== '' && block.props['uploadId'] !== undefined;
      return `${block.type}(${pending ? 'pending' : String(block.props['url'])})${quoted}`;
    }
    if (block.type === 'table' || block.type === 'docTable') return `table${quoted}`;
    const level = block.type === 'heading' ? `#${String(block.props['level'])}` : '';
    const text = (items: readonly { text?: string; content?: unknown }[]): string =>
      items.map((c) => c.text ?? (Array.isArray(c.content) ? text(c.content as { text?: string }[]) : '')).join('');
    const words = Array.isArray(block.content) ? text(block.content as { text?: string }[]) : '';
    return `${block.type}${level}${quoted}:${words}`;
  };
  const walk = (blocks: Block[], depth: number): string[] =>
    blocks.flatMap((block) => [`${'  '.repeat(depth)}${label(block)}`, ...walk(block.type === 'docTable' ? [] : block.children ?? [], depth + 1)]);
  return walk(editor.document, 0);
}

/**
 * Where the caret is: the words of its line and its offset in them.
 * @param editor - The editor.
 * @returns `words@offset`.
 */
function caret(editor: Editor): string {
  const { selection } = editor.prosemirrorView.state;
  return `${selection.empty ? '' : 'RANGE '}${selection.$head.parent.textContent}@${selection.$head.parentOffset}`;
}

/**
 * Every block id in the body.
 * @param editor - The editor.
 * @returns The ids, nested ones too.
 */
function ids(editor: Editor): string[] {
  const walk = (blocks: Block[]): string[] => blocks.flatMap((b) => [b.id, ...walk(b.children ?? [])]);
  return walk(editor.document);
}

/** A piece of content: a line of words, or a picture. */
type Piece = { words: string } | { picture: string };

/**
 * Pastes these pieces as web content.
 * @param editor - The editor.
 * @param pieces - The content.
 */
function pasteWeb(editor: Editor, pieces: readonly Piece[]): void {
  const html = pieces.map((p) => ('words' in p ? `<p>${p.words}</p>` : `<img src="${p.picture}">`)).join('');
  paste(editor, html, pieces.map((p) => ('words' in p ? p.words : '')).join('\n'));
}

/**
 * Pastes these pieces as content copied from a body.
 * @param editor - The editor.
 * @param blocks - The blocks copied.
 */
function pasteOwn(editor: Editor, blocks: readonly unknown[]): void {
  const html = editor.blocksToFullHTML(blocks as never);
  pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' });
}

/**
 * The blocks a body copy of these pieces holds.
 * @param pieces - The content.
 * @returns The blocks.
 */
function ownBlocks(pieces: readonly Piece[]): unknown[] {
  return pieces.map((p) => ('words' in p ? { type: 'paragraph', content: p.words } : { type: 'image', props: { url: p.picture } }));
}

/**
 * A canvas clipboard of these pieces, in reading order from top to bottom.
 * @param pieces - The content.
 * @returns Its plain text.
 */
function canvasClipboard(pieces: readonly Piece[]): string {
  const nodes = pieces.map(
    (p, index): ClipboardNode =>
      'words' in p
        ? ({
          id: `n${index}`,
          type: 'text',
          position: { x: 0, y: index * 300 },
          height: 100,
          data: { body: { $y: 'xml', children: [{ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: p.words }] }] }] } },
        })
        : ({ id: `n${index}`, type: 'image', position: { x: 0, y: index * 300 }, height: 100, data: { content: p.picture } }),
  );
  return serializeClipboard({ version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] });
}

/** The three sources one paste rule set covers, and how each labels a picture it puts. */
const SOURCES: [string, (editor: Editor, pieces: readonly Piece[]) => void, (url: string) => string][] = [
  ['web content', pasteWeb, (url) => `image(${url})`],
  ['the body\'s own content', (editor, pieces) => pasteOwn(editor, ownBlocks(pieces)), (url) => `image(${url})`],
  ['canvas nodes', (editor, pieces) => pasteFormats(editor, { 'text/plain': canvasClipboard(pieces) }), () => 'image(pending)'],
];

const PIC = `${OURS}p.png`;
const W: Piece = { words: 'w' };
const V: Piece = { words: 'v' };
const P: Piece = { picture: PIC };

/** Shapes of content: [name, pieces, what lands with `IMG` standing for the picture, where the caret ends]. */
type Case = [string, Piece[], string[], string];

const MIDDLE: Case[] = [
  ['a picture', [P], ['paragraph:ab', 'IMG', 'paragraph:cd'], 'cd@0'],
  ['words then a picture', [W, P], ['paragraph:abw', 'IMG', 'paragraph:cd'], 'cd@0'],
  ['a picture then words', [P, V], ['paragraph:ab', 'IMG', 'paragraph:vcd'], 'vcd@1'],
  ['words, a picture, words', [W, P, V], ['paragraph:abw', 'IMG', 'paragraph:vcd'], 'vcd@1'],
];
const START: Case[] = [
  ['a picture', [P], ['IMG', 'paragraph:abcd'], 'abcd@0'],
  ['words then a picture', [W, P], ['paragraph:w', 'IMG', 'paragraph:abcd'], 'abcd@0'],
  ['a picture then words', [P, V], ['IMG', 'paragraph:vabcd'], 'vabcd@1'],
  ['words, a picture, words', [W, P, V], ['paragraph:w', 'IMG', 'paragraph:vabcd'], 'vabcd@1'],
];
const END: Case[] = [
  ['a picture', [P], ['paragraph:abcd', 'IMG'], 'tail@0'],
  ['words then a picture', [W, P], ['paragraph:abcdw', 'IMG'], 'tail@0'],
  ['a picture then words', [P, V], ['paragraph:abcd', 'IMG', 'paragraph:v'], 'v@1'],
  ['words, a picture, words', [W, P, V], ['paragraph:abcdw', 'IMG', 'paragraph:v'], 'v@1'],
];
const EMPTY: Case[] = [
  ['a picture', [P], ['IMG', 'paragraph:'], '@0'],
  ['words then a picture', [W, P], ['paragraph:w', 'IMG', 'paragraph:'], '@0'],
  ['a picture then words', [P, V], ['IMG', 'paragraph:v'], 'v@1'],
  ['words, a picture, words', [W, P, V], ['paragraph:w', 'IMG', 'paragraph:v'], 'v@1'],
];

describe.each(SOURCES)('%s with media, on a line of words', (_source, put, img) => {
  /**
   * Opens `lead / abcd / tail`, puts the caret in `abcd`, pastes, and reads the result.
   * @param offset - Where in `abcd` the caret is.
   * @param pieces - The content.
   * @returns What lands and where the caret ends.
   */
  async function at(offset: number, pieces: Piece[]): Promise<{ lines: string[]; caret: string }> {
    const editor = open([
      { type: 'paragraph', content: 'lead' },
      { type: 'paragraph', content: 'abcd' },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'abcd', offset));
    put(editor, pieces);
    await settled();
    return { lines: lines(editor), caret: caret(editor) };
  }
  const expected = (blocks: string[]): string[] => ['paragraph:lead', ...blocks.map((b) => (b === 'IMG' ? img(PIC) : b)), 'paragraph:tail'];

  it.each(MIDDLE)('in its middle: %s splits it, never nests', async (_name, pieces, blocks, where) => {
    expect(await at(2, pieces)).toEqual({ lines: expected(blocks), caret: where });
  });

  it.each(START)('at its start: %s goes before it', async (_name, pieces, blocks, where) => {
    expect(await at(0, pieces)).toEqual({ lines: expected(blocks), caret: where });
  });

  it.each(END)('at its end: %s goes after it', async (_name, pieces, blocks, where) => {
    expect(await at(4, pieces)).toEqual({ lines: expected(blocks), caret: where });
  });
});

describe.each(SOURCES)('%s with media, on an empty line the caret is on', (_source, put, img) => {
  it.each(EMPTY)('%s goes above it, the line staying for the caret', async (_name, pieces, blocks, where) => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 1);
    put(editor, pieces);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:lead', ...blocks.map((b) => (b === 'IMG' ? img(PIC) : b)), 'paragraph:tail'],
      caret: where,
    });
  });
});

describe.each(SOURCES)('%s with media, over a selection', (_source, put, img) => {
  it('of a few words replaces them', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', 3));
    put(editor, [P]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:a', img(PIC), 'paragraph:d']);
  });

  it.each([
    ['a whole line', ['abcd'], 'abcd', 0, 'abcd', 4],
    ['two whole lines', ['abcd', 'efgh'], 'abcd', 0, 'efgh', 4],
  ])('of %s replaces it, leaving no empty line', async (_name, words, fromWords, fromOffset, toWords, toOffset) => {
    const editor = open([
      { type: 'paragraph', content: 'lead' },
      ...words.map((w) => ({ type: 'paragraph', content: w })),
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, fromWords, fromOffset), positionOf(editor, toWords, toOffset));
    put(editor, [P]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:lead', img(PIC), 'paragraph:tail'],
      caret: 'tail@0',
    });
  });
});

describe.each(SOURCES)('%s with media, a picture selected', (_source, put, img) => {
  const OLD = `${OURS}old.png`;
  const OTHER = `${OURS}other.png`;
  it.each([
    ['between two lines', [{ type: 'paragraph', content: 'lead' }, 'SELECTED', { type: 'paragraph', content: 'tail' }], ['paragraph:lead', 'paragraph:w', 'NEW', 'paragraph:tail']],
    ['last in the body', [{ type: 'paragraph', content: 'lead' }, 'SELECTED'], ['paragraph:lead', 'paragraph:w', 'NEW', 'paragraph:']],
    ['above a table', ['SELECTED', tableBlock({ rows: [{ cells: ['x'] }] })], ['paragraph:w', 'NEW', 'paragraph:', 'table']],
    ['above another picture', ['SELECTED', { type: 'image', props: { url: OTHER } }], ['paragraph:w', 'NEW', 'paragraph:', `image(${OTHER})`]],
  ])('%s is replaced in place, its neighbours taking none of the words', async (_name, blocks, expected) => {
    const editor = open(blocks.map((b) => (b === 'SELECTED' ? { type: 'image', props: { url: OLD } } : b)));
    const view = editor.prosemirrorView;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'image' && node.attrs['url'] === OLD) at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    view.focus();
    put(editor, [W, P]);
    await settled();
    expect(lines(editor)).toEqual(expected.map((b) => (b === 'NEW' ? img(PIC) : b)));
  });
});

describe.each(SOURCES)('%s with media, on a line with children', (_source, put, img) => {
  /**
   * Opens a list item `abcd` with a child, then `tail`, and pastes at an offset.
   * @param offset - Where in `abcd` the caret is.
   * @param pieces - The content.
   * @returns The editor.
   */
  async function at(offset: number, pieces: Piece[]): Promise<Editor> {
    const editor = open([
      { type: 'bulletListItem', content: 'abcd', children: [{ type: 'paragraph', content: 'kid' }] },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'abcd', offset));
    put(editor, pieces);
    await settled();
    return editor;
  }

  it('in its middle hands the children to the back half', async () => {
    const editor = await at(2, [P]);
    expect(lines(editor)).toEqual(['bulletListItem:ab', img(PIC), 'bulletListItem:cd', '  paragraph:kid', 'paragraph:tail']);
    expect(new Set(ids(editor)).size).toBe(ids(editor).length);
  });

  it.each([
    ['a picture', [P], ['bulletListItem:abcd', '  paragraph:kid', 'IMG', 'paragraph:tail']],
    ['words then a picture', [W, P], ['bulletListItem:abcdw', '  paragraph:kid', 'IMG', 'paragraph:tail']],
    ['a picture then words', [P, V], ['bulletListItem:abcd', '  paragraph:kid', 'IMG', 'paragraph:v', 'paragraph:tail']],
  ])('at its end leaves the children under it, %s going after them', async (_name, pieces, expected) => {
    const editor = await at(4, pieces);
    expect(lines(editor)).toEqual(expected.map((b) => (b === 'IMG' ? img(PIC) : b)));
    expect(new Set(ids(editor)).size).toBe(ids(editor).length);
  });
});

describe.each(SOURCES)('%s with media, in a quote', (_source, put, img) => {
  it('splitting a quoted line keeps every block put there quoted', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd', props: { quoted: true } }]);
    select(editor, positionOf(editor, 'abcd', 2));
    put(editor, [P]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph[q]:ab', `${img(PIC)}[q]`, 'paragraph[q]:cd']);
  });

  it('on an empty quoted line keeps every block put there quoted', async () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', props: { quoted: true } }]);
    caretIn(editor, 1);
    put(editor, [P]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `${img(PIC)}[q]`, 'paragraph[q]:']);
  });
});

describe('a quote copied from the body, put in a line outside quotes', () => {
  it('stays a quote', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 2));
    pasteOwn(editor, [
      { type: 'image', props: { url: PIC } },
      { type: 'paragraph', content: 'q', props: { quoted: true } },
      { type: 'image', props: { url: PIC } },
    ]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:ab', `image(${PIC})`, 'paragraph[q]:q', `image(${PIC})`, 'paragraph:cd']);
  });
});

describe.each(SOURCES)('%s with words then a picture, on an empty line that is not a paragraph', (_source, put, img) => {
  it.each([
    ['list item', { type: 'bulletListItem' }, 'bulletListItem'],
    ['heading', { type: 'heading', props: { level: 2 } }, 'heading#2'],
    ['to-do', { type: 'checkListItem' }, 'checkListItem'],
  ])('a %s gives its type to the leading words', async (_name, line, label) => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, line]);
    caretIn(editor, 1);
    put(editor, [W, P]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `${label}:w`, img(PIC), `${label}:`]);
  });
});

describe('an empty line that is not a paragraph, taking content whose last line has lines nested under it', () => {
  it.each([
    ['list item', { type: 'bulletListItem' }, 'bulletListItem'],
    ['heading', { type: 'heading', props: { level: 2 } }, 'heading#2'],
    ['to-do', { type: 'checkListItem' }, 'checkListItem'],
  ])('a %s gives its type to that line, keeps what is nested under it, and leaves no line behind', async (_name, line, label) => {
    const editor = open([{ type: 'paragraph', content: 'top' }, line, { type: 'paragraph', content: 'end' }]);
    caretIn(editor, 1);
    paste(editor, '<ul><li>a<ul><li>b</li></ul></li></ul>', 'a\nb');
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:top', `${label}:a`, '  bulletListItem:b', 'paragraph:end'],
      caret: 'b@1',
    });
  });
});

describe('an empty line that is not a paragraph, taking content whose last block is not words but has words nested under it', () => {
  it.each([
    ['heading', { type: 'heading', props: { level: 2 } }, 'heading#2'],
    ['list item', { type: 'bulletListItem' }, 'bulletListItem'],
  ])('a %s keeps a picture a picture and a code block a code block, and leaves the line for the caret', async (_name, line, label) => {
    for (const last of [
      { type: 'image', props: { url: PIC }, children: [{ type: 'paragraph', content: 'c' }] },
      { type: 'codeBlock', content: 'code', children: [{ type: 'paragraph', content: 'c' }] },
    ]) {
      const editor = open([{ type: 'paragraph', content: 'top' }, line, { type: 'paragraph', content: 'end' }]);
      caretIn(editor, 1);
      pasteOwn(editor, [{ type: 'paragraph', content: 'w' }, last]);
      await settled();
      const kept = last.type === 'image' ? `image(${PIC})` : 'codeBlock:code';
      expect(lines(editor)).toEqual(['paragraph:top', `${label}:w`, kept, '  paragraph:c', `${label}:`, 'paragraph:end']);
      unmountAll();
    }
  });
});

describe('a line the content\'s last words join', () => {
  it('keeps the reader\'s type', async () => {
    const editor = open([{ type: 'heading', content: 'abcd', props: { level: 2 } }]);
    select(editor, positionOf(editor, 'abcd', 2));
    pasteOwn(editor, [{ type: 'image', props: { url: PIC } }, { type: 'bulletListItem', content: 'x' }]);
    await settled();
    expect(lines(editor)).toEqual(['heading#2:ab', `image(${PIC})`, 'heading#2:xcd']);
  });
});

describe('a picture put last in the body', () => {
  it('opens a line after it for the caret', async () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 4));
    pasteWeb(editor, [P]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:lead', 'paragraph:abcd', `image(${PIC})`, 'paragraph:'],
      caret: '@0',
    });
  });

  it('twice on the last empty line keeps both, in order', async () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    caretIn(editor, 1);
    pasteWeb(editor, [{ picture: `${OURS}one.png` }]);
    await settled();
    pasteWeb(editor, [{ picture: `${OURS}two.png` }]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', `image(${OURS}one.png)`, `image(${OURS}two.png)`, 'paragraph:']);
  });
});

describe('content holding only paragraphs', () => {
  it('splits a line of words where the caret is', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 2));
    paste(editor, '<p>x</p><p>y</p>', 'x\ny');
    await settled();
    expect(lines(editor)).toEqual(['paragraph:abx', 'paragraph:ycd']);
  });
});

describe.each(SOURCES)('%s of lines of words alone, on a line that is not a paragraph', (_source, put) => {
  /**
   * Opens a heading `abcd`, puts the caret in it, pastes, and reads the result.
   * @param offset - Where in `abcd` the caret is.
   * @param pieces - The content.
   * @returns What lands.
   */
  async function at(offset: number, pieces: Piece[]): Promise<string[]> {
    const editor = open([{ type: 'heading', content: 'abcd', props: { level: 2 } }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'abcd', offset));
    put(editor, pieces);
    await settled();
    return lines(editor);
  }

  it('in its middle keeps the reader\'s type on both halves', async () => {
    expect(await at(2, [W, V])).toEqual(['heading#2:abw', 'heading#2:vcd', 'paragraph:tail']);
  });

  it('at its start keeps the reader\'s type on the line the last words join', async () => {
    expect(await at(0, [W, V])).toEqual(['paragraph:w', 'heading#2:vabcd', 'paragraph:tail']);
  });

  it('at its end keeps the reader\'s type on the line the first words join', async () => {
    expect(await at(4, [W, V])).toEqual(['heading#2:abcdw', 'paragraph:v', 'paragraph:tail']);
  });

  it('of one line goes into the line as its words', async () => {
    expect(await at(2, [W])).toEqual(['heading#2:abwcd', 'paragraph:tail']);
  });
});

describe('web content of lines of words, its spaces', () => {
  it('are the spaces the page shows, runs of them one space', async () => {
    const editor = open([{ type: 'paragraph', content: 'xy' }]);
    select(editor, positionOf(editor, 'xy', 2));
    paste(editor, '<p>ab  cd</p>\n  <p>e <span>f</span> <span> g </span></p>', 'ab cd\ne f g');
    await settled();
    expect(lines(editor)).toEqual(['paragraph:xyab cd', 'paragraph:e f g']);
  });

  it('from Notion keep its line breaks', async () => {
    const editor = open([{ type: 'paragraph', content: 'xy' }]);
    select(editor, positionOf(editor, 'xy', 2));
    paste(editor, '<!-- notionvc: 1 --><p>a  b\nc</p><p>d</p>', 'a  b\nc\nd');
    await settled();
    expect(lines(editor)).toEqual(['paragraph:xya b\nc', 'paragraph:d']);
  });

  it('in code stay as they are', async () => {
    const editor = open([{ type: 'paragraph', content: 'xy' }]);
    select(editor, positionOf(editor, 'xy', 2));
    paste(editor, '<p>a  b</p><pre><code>c  d</code></pre>', 'a b\nc  d');
    await settled();
    expect(lines(editor)).toEqual(['paragraph:xya b', 'codeBlock:c  d']);
  });
});

describe('web content of lines of words alone, over the whole of a heading', () => {
  it('gives the heading\'s type to the leading words, as content holding a picture does', async () => {
    const editor = open([{ type: 'heading', content: 'Head', props: { level: 2 } }, { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'Head', 0), positionOf(editor, 'Head', 4));
    paste(editor, '<p>x</p><p>y</p>', 'x\ny');
    await settled();
    expect(lines(editor)).toEqual(['heading#2:x', 'paragraph:y', 'paragraph:tail']);
  });
});

describe('canvas words pasted with a picture', () => {
  it('keep every space and tab', async () => {
    const editor = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
    caretIn(editor, 1);
    const words = { $y: 'xml', children: ['a   b', '  ind\tT '].map((line) => ({ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: line }] }] })) };
    const nodes = [
      { id: 't', type: 'text', position: { x: 0, y: 0 }, height: 100, data: { body: words } },
      { id: 'i', type: 'image', position: { x: 0, y: 300 }, height: 100, data: { content: PIC } },
    ] as ClipboardNode[];
    pasteFormats(editor, { 'text/plain': serializeClipboard({ version: 2, picked: ['t', 'i'], nodes, edges: [] }) });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', 'paragraph:a   b', 'paragraph:  ind\tT ', 'image(pending)', 'paragraph:']);
  });

  it('over selected words: an address alone in the words replaces them, and the picture lands', async () => {
    const editor = open([{ type: 'paragraph', content: 'pick these words here' }]);
    select(editor, positionOf(editor, 'these words', 0), positionOf(editor, 'these words', 11));
    pasteFormats(editor, { 'text/plain': canvasClipboard([{ words: 'https://example.com/src' }, P]) });
    await settled();
    expect(lines(editor)).toEqual(['paragraph:pick https://example.com/src', 'image(pending)', 'paragraph: here']);
  });
});

describe.each(SOURCES)('%s with words then a picture, over the whole of a line that is not a paragraph', (_source, put, img) => {
  it('gives the line\'s type to the leading words', async () => {
    const editor = open([
      { type: 'paragraph', content: 'lead' },
      { type: 'bulletListItem', content: 'abcd' },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'abcd', 4));
    put(editor, [W, P]);
    await settled();
    expect(lines(editor)).toEqual(['paragraph:lead', 'bulletListItem:w', img(PIC), 'paragraph:tail']);
  });
});

describe('a picture put at the end of a nested last line', () => {
  it('leaves the caret at the start of the line that follows, opening none', async () => {
    const editor = open([
      { type: 'bulletListItem', content: 'parent', children: [{ type: 'bulletListItem', content: 'kid' }] },
      { type: 'paragraph', content: 'next' },
    ]);
    select(editor, positionOf(editor, 'kid', 3));
    pasteFormats(editor, { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['bulletListItem:parent', '  bulletListItem:kid', `  image(${PIC})`, 'paragraph:next'],
      caret: 'next@0',
    });
  });
});

describe('the line opened for the caret, in a quote', () => {
  it('is quoted as the line the content went into', async () => {
    const editor = open([
      { type: 'paragraph', content: 'a', props: { quoted: true } },
      { type: 'image', props: { url: `${OURS}q.png`, quoted: true } },
    ]);
    select(editor, positionOf(editor, 'a', 1));
    pasteFormats(editor, { 'text/html': `<img src="${PIC}">`, 'text/plain': '' });
    await settled();
    expect(lines(editor)).toEqual(['paragraph[q]:a', `image(${PIC})[q]`, 'paragraph[q]:', `image(${OURS}q.png)[q]`]);
  });
});

describe('content holding a medium, pasted with the caret in the gap between two pictures', () => {
  /**
   * Opens two pictures with the caret in the gap between them, where an
   * arrow key from the second one puts it.
   * @returns The editor.
   */
  function gap(): Editor {
    const editor = open([{ type: 'image', props: { url: `${OURS}a.png` } }, { type: 'image', props: { url: `${OURS}b.png` } }]);
    const view = editor.prosemirrorView;
    let second = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && String(node.attrs['url']).endsWith('b.png')) second = pos - 1;
      return second < 0;
    });
    view.dispatch(view.state.tr.setSelection(new GapCursor(view.state.doc.resolve(second))));
    view.focus();
    return editor;
  }

  it.each(SOURCES)('lands there, from %s', async (_source, put, img) => {
    const editor = gap();
    put(editor, [W, P]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: [`image(${OURS}a.png)`, 'paragraph:w', img(PIC), 'paragraph:', `image(${OURS}b.png)`],
      caret: '@0',
    });
  });
});

describe('content holding a medium, pasted in the gap between two quoted pictures', () => {
  it('is quoted as they are', async () => {
    const editor = open([{ type: 'image', props: { url: `${OURS}a.png`, quoted: true } }, { type: 'image', props: { url: `${OURS}b.png`, quoted: true } }]);
    const view = editor.prosemirrorView;
    let second = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && String(node.attrs['url']).endsWith('b.png')) second = pos - 1;
      return second < 0;
    });
    view.dispatch(view.state.tr.setSelection(new GapCursor(view.state.doc.resolve(second))));
    view.focus();
    pasteWeb(editor, [W, P]);
    await settled();
    expect(lines(editor)).toEqual([`image(${OURS}a.png)[q]`, 'paragraph[q]:w', `image(${PIC})[q]`, 'paragraph[q]:', `image(${OURS}b.png)[q]`]);
  });
});

describe('the caret after content, with nested blocks about', () => {
  const withKid = (words: string): unknown => ({ type: 'paragraph', content: words, children: [{ type: 'paragraph', content: 'kid' }] });

  it('stays after the content\'s last words when the replaced line hands them its children', async () => {
    const editor = open([withKid('abcd'), { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'abcd', 4));
    pasteWeb(editor, [P, V]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: [`image(${PIC})`, 'paragraph:v', '  paragraph:kid', 'paragraph:tail'],
      caret: 'v@1',
    });
  });

  it('opens no line at the body\'s end when the content ends in words', async () => {
    const editor = open([withKid('abcd')]);
    select(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'abcd', 4));
    pasteWeb(editor, [P, V]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: [`image(${PIC})`, 'paragraph:v', '  paragraph:kid'],
      caret: 'v@1',
    });
  });

  it('goes to the first child handed to a picture the content ends in', async () => {
    const editor = open([withKid('abc'), { type: 'paragraph', content: 'tail' }]);
    select(editor, positionOf(editor, 'abc', 0), positionOf(editor, 'abc', 3));
    pasteWeb(editor, [W, P]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:w', `image(${PIC})`, '  paragraph:kid', 'paragraph:tail'],
      caret: 'kid@0',
    });
  });

  it('stays after the content\'s own nested last words, at a line\'s end', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd' }, { type: 'paragraph', content: 'tail' }]);
    caretIn(editor, 0);
    pasteOwn(editor, [{ type: 'image', props: { url: PIC } }, { type: 'paragraph', content: 'v', children: [{ type: 'paragraph', content: 'c' }] }]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:abcd', `image(${PIC})`, 'paragraph:v', '  paragraph:c', 'paragraph:tail'],
      caret: 'c@1',
    });
  });

  it('stays after the content\'s own nested last words, in a line\'s middle', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 2));
    pasteOwn(editor, [{ type: 'paragraph', content: 'w' }, { type: 'image', props: { url: PIC }, children: [{ type: 'paragraph', content: 'c' }] }]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:abw', `image(${PIC})`, '  paragraph:c', 'paragraph:cd'],
      caret: 'c@1',
    });
  });

  it('stays after the content\'s last words when a selected picture hands them its children', async () => {
    const editor = open([
      { type: 'paragraph', content: 'lead' },
      { type: 'image', props: { url: `${OURS}q.png` }, children: [{ type: 'paragraph', content: 'kid' }] },
      { type: 'paragraph', content: 'tail' },
    ]);
    const view = editor.prosemirrorView;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'image') at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    view.focus();
    pasteWeb(editor, [P, V]);
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['paragraph:lead', `image(${PIC})`, 'paragraph:v', '  paragraph:kid', 'paragraph:tail'],
      caret: 'v@1',
    });
  });

  it('keeps canvas media and the following caret inside the target cell', async () => {
    const editor = open([TABLE, { type: 'paragraph', content: 'tail' }]);
    await settled();
    caretIn(editor, 0);
    pasteFormats(editor, { 'text/plain': canvasClipboard([P, W]) });
    await settled();
    expect({ lines: lines(editor), caret: caret(editor) }).toEqual({
      lines: ['table', 'paragraph:tail'],
      caret: 'w@1',
    });
    const cell = (editor.document as Block[])[0]!.children![0]!.children![0]!;
    expect(cell.children!.map((block) => block.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(cell.children![1]!.props['url']).toBe('');
    expect(cell.children![1]!.props['uploadId']).not.toBe('');
    expect(editor.prosemirrorView.state.selection.$head.node(-2).type.name).toBe('docTableCell');
  });
});

it('keeps the caret paragraph quoted after a table pasted at the end of a quote', () => {
  const editor = open([{ type: 'paragraph', props: { quoted: true }, content: 'a' }]);
  select(editor, positionOf(editor, 'a', 1));

  paste(editor, '<table><tr><td>n</td></tr></table>', 'n');

  expect((editor.document as Block[]).map((block) => [block.type, block.props['quoted']])).toEqual([
    ['paragraph', true], ['docTable', true], ['paragraph', true],
  ]);
});
