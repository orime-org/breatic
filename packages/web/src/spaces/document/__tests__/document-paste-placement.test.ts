// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where content holding media lands (inner#1351 + inner#1390 design §5.4.3,
 * A1, A2, A5): the target settled from the selection first, then one set of
 * placement rules for web content, the body's own content and the canvas
 * alike, and the caret after what was put.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeSelection } from '@tiptap/pm/state';

import { serializeClipboard, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

import { OURS, caretIn, open as openBody, paste, pasteFormats, positionOf, select, settled, unmountAll, type Editor } from './paste-harness';

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
    if (block.type === 'table') return `table${quoted}`;
    const level = block.type === 'heading' ? `#${String(block.props['level'])}` : '';
    const words = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '';
    return `${block.type}${level}${quoted}:${words}`;
  };
  const walk = (blocks: Block[], depth: number): string[] =>
    blocks.flatMap((block) => [`${'  '.repeat(depth)}${label(block)}`, ...walk(block.children ?? [], depth + 1)]);
  return walk(editor.document as Block[], 0);
}

/**
 * Where the caret is: the words of its line and its offset in them.
 * @param editor - The editor.
 * @returns `words@offset`.
 */
function caret(editor: Editor): string {
  const { selection } = editor.prosemirrorView!.state;
  return `${selection.empty ? '' : 'RANGE '}${selection.$head.parent.textContent}@${selection.$head.parentOffset}`;
}

/**
 * Every block id in the body.
 * @param editor - The editor.
 * @returns The ids, nested ones too.
 */
function ids(editor: Editor): string[] {
  const walk = (blocks: Block[]): string[] => blocks.flatMap((b) => [b.id, ...walk(b.children ?? [])]);
  return walk(editor.document as Block[]);
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
        } as ClipboardNode)
        : ({ id: `n${index}`, type: 'image', position: { x: 0, y: index * 300 }, height: 100, data: { content: p.picture } } as ClipboardNode),
  );
  return serializeClipboard({ version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] } as ClipboardPayload);
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
    ['above a table', ['SELECTED', { type: 'table', content: { type: 'tableContent', rows: [{ cells: [['x']] }] } }], ['paragraph:w', 'NEW', 'paragraph:', 'table']],
    ['above another picture', ['SELECTED', { type: 'image', props: { url: OTHER } }], ['paragraph:w', 'NEW', 'paragraph:', `image(${OTHER})`]],
  ])('%s is replaced in place, its neighbours taking none of the words', async (_name, blocks, expected) => {
    const editor = open(blocks.map((b) => (b === 'SELECTED' ? { type: 'image', props: { url: OLD } } : b)));
    const view = editor.prosemirrorView!;
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
  it('lands as it does on main', async () => {
    const editor = open([{ type: 'paragraph', content: 'abcd' }]);
    select(editor, positionOf(editor, 'abcd', 2));
    paste(editor, '<p>x</p><p>y</p>', 'x\ny');
    await settled();
    expect(lines(editor)).toEqual(['paragraph:abx', 'paragraph:ycd']);
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
    pasteFormats(editor, { 'text/plain': serializeClipboard({ version: 2, picked: ['t', 'i'], nodes, edges: [] } as ClipboardPayload) });
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
