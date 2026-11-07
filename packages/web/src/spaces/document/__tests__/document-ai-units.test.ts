// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI dialog sends, previews and writes (inner#1860 A6, design §4.6,
 * §5.1–§5.4, §8): the range's Markdown goes out whole, the whole answer read
 * into blocks is the preview, and replace pastes it over the range the way
 * Plate's `replaceSelection` does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { aiCapture } from '@web/spaces/document/document-ai-launch';
import { aiCoverIn, DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import {
  aiAnswer,
  aiAnswerEmpty,
  aiRequest,
  insertAiAnswer,
  replaceAiAnswer,
  type AiAnswer,
} from '@web/spaces/document/document-ai-units';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import type { LocalRange } from '@web/spaces/document/document-local-range';
import type { ProposalAdmission } from '@web/spaces/document/document-proposal-landing';

/** Our own asset host, so media there is ours and survives a write. */
const OURS = 'https://assets.example/';

vi.mock('@web/spaces/document/document-external-media', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ourMediaPrefix: () => OURS,
  ourMediaPrefixReady: async () => OURS,
}));

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

const WRITABLE = (): ProposalAdmission => ({ available: true, writeAccess: 'granted' });

/** A block as the editor reads it, loosely typed for assertions. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: Seen[];
}

/** One piece of inline content, loosely typed. */
interface Piece {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  href?: string;
  content?: Piece[];
}

/**
 * A mounted document holding some Markdown, as a Space opens it.
 * @param markdown - What it holds.
 * @returns The handle.
 */
async function open(markdown: string): Promise<DocumentEditorHandle> {
  const doc = new Y.Doc();
  const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  if (markdown !== '') {
    handle.editor.replaceBlocks(handle.editor.document, handle.editor.tryParseMarkdownToBlocks(markdown));
  }
  handle.undoManager.clear();
  return handle;
}

/**
 * A mounted document holding some blocks.
 * @param list - The blocks, as the block API takes them.
 * @returns The handle.
 */
async function openBlocks(list: unknown[]): Promise<DocumentEditorHandle> {
  const handle = await open('');
  handle.editor.replaceBlocks(handle.editor.document, list as never);
  handle.undoManager.clear();
  return handle;
}

/**
 * The body's blocks.
 * @param handle - The document.
 * @returns Them.
 */
function blocks(handle: DocumentEditorHandle): Seen[] {
  return handle.editor.document as unknown as Seen[];
}

/**
 * Some inline content's words, a hard break read as a newline.
 * @param content - The content.
 * @returns Its words.
 */
function wordsOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as Piece[]).map((c) => (c.type === 'link' ? wordsOf(c.content) : c.text ?? '')).join('');
}

/**
 * A block's words.
 * @param block - The block.
 * @returns Its words.
 */
function textOf(block: Seen): string {
  return wordsOf(block.content);
}

/**
 * Every block in document order, children after their parent.
 * @param handle - The document.
 * @returns Them.
 */
function flat(handle: DocumentEditorHandle): Seen[] {
  const out: Seen[] = [];
  const walk = (list: Seen[]): void => {
    for (const b of list) {
      out.push(b);
      walk(b.children);
    }
  };
  walk(blocks(handle));
  return out;
}

/**
 * Where some words sit.
 * @param handle - The document.
 * @param words - Words inside one text node.
 * @returns Their range.
 * @throws {Error} When no text node holds them.
 */
function rangeOf(handle: DocumentEditorHandle, words: string): LocalRange {
  let found: LocalRange | null = null;
  handle.editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== null) return false;
    const index = node.isText ? (node.text ?? '').indexOf(words) : -1;
    if (index >= 0) found = { from: pos + index, to: pos + index + words.length };
    return found === null;
  });
  if (found === null) throw new Error(`no text holds ${JSON.stringify(words)}`);
  return found;
}

/**
 * A block's own content, from its start to its end.
 * @param handle - The document.
 * @param id - The block.
 * @returns The range.
 * @throws {Error} When there is no such block.
 */
function contentOf(handle: DocumentEditorHandle, id: string): LocalRange {
  let found: LocalRange | null = null;
  handle.editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'blockContainer' && node.attrs['id'] === id) {
      const content = node.firstChild!;
      found = { from: pos + 2, to: pos + 2 + content.content.size };
    }
    return found === null;
  });
  if (found === null) throw new Error(`no block ${id}`);
  return found;
}

/**
 * Selects a stretch and opens the dialog on it, as the dialog does.
 * @param handle - The document.
 * @param range - The stretch.
 */
function capture(handle: DocumentEditorHandle, range: LocalRange): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  const captured = aiCapture(view.state);
  expect(captured).not.toBeNull();
  view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, captured));
}

/**
 * What replace would cover now.
 * @param handle - The document.
 * @returns The range, or null once it is gone.
 */
function cover(handle: DocumentEditorHandle): LocalRange | null {
  return aiCoverIn(handle.editor.prosemirrorState);
}

/**
 * What the dialog sends for the open range.
 * @param handle - The document.
 * @returns The selection's Markdown.
 */
function request(handle: DocumentEditorHandle): string {
  return aiRequest(handle.editor, handle.editor.prosemirrorState.doc, cover(handle)!);
}

/**
 * Reads an answer the way the dialog does.
 * @param handle - The document.
 * @param text - The answer.
 * @returns The answer.
 */
function read(handle: DocumentEditorHandle, text: string): AiAnswer {
  return aiAnswer(handle.editor, handle.editor.prosemirrorState.doc, text, OURS, cover(handle));
}

/**
 * Opens the dialog over a stretch, answers and replaces.
 * @param handle - The document.
 * @param range - The stretch.
 * @param answerFor - The model, given what was sent.
 * @returns The answer that was written.
 */
function replaceWith(handle: DocumentEditorHandle, range: LocalRange, answerFor: (sent: string) => string): AiAnswer {
  capture(handle, range);
  const answer = read(handle, answerFor(request(handle)));
  expect(replaceAiAnswer(handle, answer, cover(handle), WRITABLE).outcome).toBe('written');
  return answer;
}

/**
 * A block without its ids, for comparing what was written with the preview.
 * @param block - The block.
 * @returns It, ids taken out.
 */
function idless(block: unknown): unknown {
  return JSON.parse(JSON.stringify(block, (key, value: unknown) => (key === 'id' ? undefined : value)));
}

/**
 * Types words at a position, as the user would.
 * @param handle - The document.
 * @param pos - Where.
 * @param words - What.
 */
function type(handle: DocumentEditorHandle, pos: number, words: string): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(words, pos));
}

/**
 * Puts a legacy table (one paragraph per cell) at the top of the body.
 * @param handle - The document.
 * @param rows - Each row's cell words.
 */
function legacyTable(handle: DocumentEditorHandle, rows: string[][]): void {
  const view = handle.editor.prosemirrorView!;
  const s = view.state.schema;
  const line = (t: string): ReturnType<typeof s.node> => s.nodes['tableParagraph']!.create(null, t === '' ? [] : [s.text(t)]);
  const table = s.nodes['table']!.create(null, rows.map((row) => s.nodes['tableRow']!.create(null, row.map((t) => s.nodes['tableCell']!.create(null, [line(t)])))));
  const container = s.nodes['blockContainer']!.create({ id: 'legacy-table' }, [table]);
  view.dispatch(view.state.tr.insert(1, container));
  handle.undoManager.clear();
}

/**
 * A legacy table's cell words.
 * @param handle - The document.
 * @returns Each row's cells.
 */
function legacyCells(handle: DocumentEditorHandle): string[][] {
  const table = blocks(handle).find((b) => b.type === 'table')!;
  const rows = (table.content as { rows: Array<{ cells: Array<{ content: Piece[] }> }> }).rows;
  return rows.map((row) => row.cells.map((cell) => cell.content.map((c) => (c.type === 'text' ? c.text : '\n')).join('')));
}

/**
 * Every docTable cell's words, row by row.
 * @param table - The table block.
 * @returns The words.
 */
function docCells(table: Seen): string[][] {
  return table.children.map((row) => row.children.map((cell) => cell.children.map(textOf).join('\n')));
}

/** The characters the escape pair is tried on. */
const TRICKY = ['a', 'b', ' ', ' ', '\n', '\\', '*', '_', '`', '#', '[', ']', '(', ')', '<', '>', '&', ';', '|', '!', '1', '.', '-', '+', '=', '~', '"', '%', ':', '/'];

describe('the range sent (§4.6, §5.2)', () => {
  it('sends only the selected words when the selection stays in one block', async () => {
    const h = await open('Intro: x y z end.');
    capture(h, rangeOf(h, 'x y z'));
    expect(request(h)).toBe('x y z');
  });

  it('sends the whole blocks a selection across blocks touches', async () => {
    const h = await open('## Head line\n\nBody text here');
    capture(h, { from: rangeOf(h, 'line').from, to: rangeOf(h, 'Body').to });
    expect(request(h)).toBe('## Head line\n\nBody text here');
  });

  it('sends the whole table a selection runs into from outside', async () => {
    const h = await open('Before\n\n| a | b |\n| --- | --- |\n| c | d |');
    capture(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'c').to });
    expect(request(h)).toBe('Before\n\n| a | b |\n| --- | --- |\n| c | d |');
  });

  it('sends the selected words of a legacy table cell as escaped text', async () => {
    const h = await open('');
    legacyTable(h, [['2. Methods', 'y']]);
    capture(h, rangeOf(h, '2. Methods'));
    expect(request(h)).toBe('2\\. Methods');
  });
});

describe('the escape pair (§5.1)', () => {
  it.each([
    '2. Methods',
    '# Total',
    '* star item',
    '[l](u)',
    'a <b> c',
    'a *b* c',
    'R&D and x > 3',
    '&lt; literal',
    'say "hi" 50% a;b',
    'https://x.y/z and a@b.c',
    'a\\b and a\\:b',
    'under_score __init__',
    '`tick` and ``two``',
    '  two lead, a  b, trail  ',
    '| pipe |',
  ])('echoes %j back unchanged', async (words) => {
    const h = await openBlocks([{ type: 'paragraph', content: words }]);
    replaceWith(h, contentOf(h, blocks(h)[0]!.id), (sent) => sent);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', words]]);
  });

  it('echoes hard breaks in a heading and a list item, and at a block edge, unchanged', async () => {
    const h = await openBlocks([
      { type: 'heading', props: { level: 2 }, content: 'head\nline' },
      { type: 'bulletListItem', content: 'item\nmore' },
      { type: 'paragraph', content: '\nleading break' },
      { type: 'paragraph', content: 'trailing break\n' },
    ]);
    const all = blocks(h);
    replaceWith(h, { from: contentOf(h, all[0]!.id).from, to: contentOf(h, all[3]!.id).to }, (sent) => sent);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['heading', 'head\nline'],
      ['bulletListItem', 'item\nmore'],
      ['paragraph', '\nleading break'],
      ['paragraph', 'trailing break\n'],
    ]);
  });

  it('echoes bold that starts with a space, and inline code, unchanged', async () => {
    const h = await openBlocks([{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'x', styles: {} },
        { type: 'text', text: ' y', styles: { bold: true } },
        { type: 'text', text: ' f(*args)', styles: { code: true } },
      ],
    }]);
    replaceWith(h, contentOf(h, blocks(h)[0]!.id), (sent) => sent);
    expect((blocks(h)[0]!.content as Piece[]).map((c) => [c.text, c.styles])).toEqual([
      ['x', {}],
      [' y', { bold: true }],
      [' f(*args)', { code: true }],
    ]);
  });

  it('echoes a link whose address holds brackets and an ampersand', async () => {
    const h = await openBlocks([{
      type: 'paragraph',
      content: [{ type: 'link', href: 'https://x.y/a_(b)?c=1&d=2', content: 'see this' }],
    }]);
    replaceWith(h, contentOf(h, blocks(h)[0]!.id), (sent) => sent);
    const link = (blocks(h)[0]!.content as Piece[])[0]!;
    expect([link.type, link.href, wordsOf(link.content)]).toEqual(['link', 'https://x.y/a_(b)?c=1&d=2', 'see this']);
  });

  it('echoes a pipe table and an HTML-form table with punctuation in their cells unchanged', async () => {
    const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
    const cells = blocks(h)[1]!.children.flatMap((row) => row.children);
    h.editor.updateBlock(cells[2]!.children[0]!.id, { content: 'a|b *c* 2. Methods [l](u) \\' } as never);
    const pipe = docCells(blocks(h)[1]!);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(blocks(h).map((b) => b.type)).toEqual(['paragraph', 'docTable', 'paragraph']);
    expect(docCells(blocks(h)[1]!)).toEqual(pipe);
    // A cell holding two paragraphs is written as an HTML table.
    const again = blocks(h)[1]!.children.flatMap((row) => row.children);
    h.editor.insertBlocks([{ type: 'paragraph', content: 'R&D <x> \\y *z* 2. w' }] as never, again[3]!.children[0]!.id, 'after');
    const html = docCells(blocks(h)[1]!);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(docCells(blocks(h)[1]!)).toEqual(html);
  });

  it('echoes a list item that holds a table, its own words and the paragraph under it read as words', async () => {
    const h = await open('');
    const table = h.editor.tryParseMarkdownToBlocks('| a | b |\n| --- | --- |\n| c | d |')[0];
    h.editor.replaceBlocks(h.editor.document, [
      { type: 'paragraph', content: 'Before' },
      { type: 'bulletListItem', content: '2. Methods [l](u)', children: [table, { type: 'paragraph', content: '2. under [x](y)' }] },
      { type: 'paragraph', content: 'After' },
    ] as never);
    const before = flat(h).map((b) => [b.type, textOf(b)]);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual(before);
  });

  it('echoes the selected words of a legacy cell that read as block syntax', async () => {
    const h = await open('');
    legacyTable(h, [['2. Methods', '# Total a *b* c']]);
    replaceWith(h, rangeOf(h, '2. Methods'), (sent) => sent);
    replaceWith(h, rangeOf(h, '# Total a *b* c'), (sent) => sent);
    expect(legacyCells(h)).toEqual([['2. Methods', '# Total a *b* c']]);
  });

  it('echoes any words in a paragraph unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: fc.constantFrom(...TRICKY), minLength: 1, maxLength: 24 }), async (words) => {
        fc.pre(/\S/.test(words));
        const h = await openBlocks([{ type: 'paragraph', content: words }]);
        replaceWith(h, contentOf(h, blocks(h)[0]!.id), (sent) => sent);
        expect(blocks(h).map(textOf)).toEqual([words]);
        _resetDocumentEditorCacheForTests();
        document.body.innerHTML = '';
      }),
      { numRuns: 60 },
    );
  });

  it('echoes any document of paragraphs, headings and list items unchanged', async () => {
    const block = fc.record({
      type: fc.constantFrom('paragraph', 'heading', 'bulletListItem', 'numberedListItem'),
      content: fc.string({ unit: fc.constantFrom('a', 'b', ' ', '*', '_', '#', '1', '.', '[', ']', '<', '&', '\\', '|', '`'), minLength: 1, maxLength: 12 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(block, { minLength: 2, maxLength: 5 }), async (list) => {
        fc.pre(list.every((b) => /\S/.test(b.content)));
        const h = await openBlocks(list);
        const before = blocks(h).map((b) => [b.type, textOf(b)]);
        const all = blocks(h);
        replaceWith(h, { from: contentOf(h, all[0]!.id).from, to: contentOf(h, all[all.length - 1]!.id).to }, (sent) => sent);
        expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual(before);
        _resetDocumentEditorCacheForTests();
        document.body.innerHTML = '';
      }),
      { numRuns: 40 },
    );
  });
});

describe('the answer as blocks (§5.3)', () => {
  it('reads an expand answer of two paragraphs as two paragraphs', async () => {
    const h = await open('One idea.');
    capture(h, rangeOf(h, 'One idea.'));
    expect((read(h, 'First part.\n\nSecond part.').preview as Seen[]).map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'First part.'],
      ['paragraph', 'Second part.'],
    ]);
  });

  it('reads a list as a list and three paragraphs merged into one as one', async () => {
    const h = await open('a\n\nb\n\nc');
    capture(h, { from: rangeOf(h, 'a').from, to: rangeOf(h, 'c').to });
    expect((read(h, '- a\n- b').preview as Seen[]).map((b) => b.type)).toEqual(['bulletListItem', 'bulletListItem']);
    expect((read(h, 'a b c').preview as Seen[]).map((b) => b.type)).toEqual(['paragraph']);
  });

  it('leaves outside images out and counts them', async () => {
    const h = await open('Text.');
    capture(h, rangeOf(h, 'Text.'));
    const answer = read(h, 'New.\n\n![x](https://elsewhere.example/x.png)');
    expect((answer.preview as Seen[]).map((b) => b.type)).toEqual(['paragraph']);
    expect(answer.leftOut).toBe(1);
  });

  it('is empty for an answer of only white space', () => {
    expect(aiAnswerEmpty('  \n ')).toBe(true);
    expect(aiAnswerEmpty('x')).toBe(false);
  });

  it('gives the first block the kind, props and first words\' style of the range\'s first block', async () => {
    const h = await openBlocks([{
      type: 'heading',
      props: { level: 2, textColor: 'red' },
      content: [{ type: 'text', text: 'Bold', styles: { bold: true } }, { type: 'text', text: ' head', styles: {} }],
    }]);
    capture(h, contentOf(h, blocks(h)[0]!.id));
    const preview = read(h, '*New* head\n\nSecond.').preview as Seen[];
    expect([preview[0]!.type, preview[0]!.props['level'], preview[0]!.props['textColor']]).toEqual(['heading', 2, 'red']);
    expect((preview[0]!.content as Piece[]).map((c) => c.styles)).toEqual([{ bold: true, italic: true }, { bold: true }]);
    expect([preview[1]!.type, preview[1]!.props['textColor']]).toEqual(['paragraph', 'default']);
  });

  it('takes no block props for an answer with list items', async () => {
    const h = await openBlocks([{ type: 'paragraph', props: { textColor: 'red' }, content: 'Para' }]);
    capture(h, contentOf(h, blocks(h)[0]!.id));
    const preview = read(h, '- a\n- b').preview as Seen[];
    expect(preview.map((b) => [b.type, b.props['textColor']])).toEqual([['bulletListItem', 'default'], ['bulletListItem', 'default']]);
  });

  it.each([
    ['a table', '| p | q |\n| --- | --- |\n| r | s |\n\nAfter.', 'docTable'],
    ['an image', `![i](${OURS}a.png)\n\nAfter.`, 'image'],
    ['a code block', '```js\nconst a = 1;\n```\n\nAfter.', 'codeBlock'],
  ])('writes an answer opening with %s as it is', async (_name, text, kind) => {
    const h = await open('## Head');
    capture(h, contentOf(h, blocks(h)[0]!.id));
    const answer = read(h, text);
    expect((answer.preview as Seen[])[0]!.type).toBe(kind);
    expect(replaceAiAnswer(h, answer, cover(h), WRITABLE).outcome).toBe('written');
    expect(blocks(h)[0]!.type).toBe(kind);
  });

  it('writes a paragraph answer for a code block as a paragraph', async () => {
    const h = await open('```js\nconst a = 1;\n```');
    capture(h, contentOf(h, blocks(h)[0]!.id));
    const preview = read(h, 'It sets **a** to one.').preview as Seen[];
    expect(preview[0]!.type).toBe('paragraph');
    expect((preview[0]!.content as Piece[]).map((c) => c.styles)).toEqual([{}, { bold: true }, {}]);
  });

  it('unfolds a table answered inside a docTable cell, the outer table unchanged', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | d |');
    replaceWith(h, rangeOf(h, 'c'), () => '| p | q |\n| --- | --- |\n| r | s |');
    const tables = flat(h).filter((b) => b.type === 'docTable');
    expect(tables).toHaveLength(1);
    expect(tables[0]!.children.map((row) => row.children.length)).toEqual([2, 2]);
  });

  it('writes a list answered for a legacy cell as its words on lines', async () => {
    const h = await open('');
    legacyTable(h, [['x', 'y']]);
    replaceWith(h, rangeOf(h, 'x'), () => '- a\n- b');
    expect(legacyCells(h)).toEqual([['a\nb', 'y']]);
  });
});

describe('replace, whole blocks (§5.3, Plate wholeTextBlocks)', () => {
  it('turns a whole paragraph answered with a list into the list', async () => {
    const h = await open('Para one.\n\nAfter.');
    replaceWith(h, rangeOf(h, 'Para one.'), () => '- a\n- b\n- c');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['bulletListItem', 'a'],
      ['bulletListItem', 'b'],
      ['bulletListItem', 'c'],
      ['paragraph', 'After.'],
    ]);
  });

  it('writes exactly the preview blocks where the range was, the rest unchanged, one undo away', async () => {
    const h = await open('Before.\n\n## Head\n\nPara\n\n- item\n\nAfter.');
    const answer = replaceWith(h, { from: rangeOf(h, 'ead').from, to: rangeOf(h, 'ite').to }, () => '## New head\n\n- a\n- b\n\nPlain now');
    expect(blocks(h).slice(1, -1).map(idless)).toEqual(answer.preview.map(idless));
    expect([textOf(blocks(h)[0]!), textOf(blocks(h).at(-1)!)]).toEqual(['Before.', 'After.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['Before.', 'Head', 'Para', 'item', 'After.']);
  });

  it('overwrites an image and an empty line at the edges of the range, undo bringing them back', async () => {
    const h = await openBlocks([
      { type: 'paragraph', content: 'Before.' },
      { type: 'image', props: { url: `${OURS}a.png` } },
      { type: 'paragraph', content: 'Middle.' },
      { type: 'paragraph' },
      { type: 'paragraph', content: 'After.' },
    ]);
    // From the end of "Before." to the empty line: a range starting at the
    // end of a block leaves that block out, so the image comes first.
    replaceWith(h, { from: rangeOf(h, 'Before.').to, to: contentOf(h, blocks(h)[3]!.id).to }, () => 'Rewritten.');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'Before.'], ['paragraph', 'Rewritten.'], ['paragraph', 'After.']]);
    h.undoManager.undo();
    expect(blocks(h).map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph', 'paragraph', 'paragraph']);
  });

  it('covers from the block of the first tracked word once the first block was deleted', async () => {
    const h = await open('One.\n\nTwo.\n\nThree.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One.').from, to: rangeOf(h, 'Three.').to });
    h.editor.removeBlocks([blocks(h)[0]!.id]);
    replaceAiAnswer(h, read(h, 'New.'), cover(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['New.', 'After.']);
  });

  it('leaves the body outside the range alone once the first block was moved past the last', async () => {
    const h = await open('One.\n\nTwo.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One.').from, to: rangeOf(h, 'Two.').to });
    h.editor.setTextCursorPosition(blocks(h)[0]!.id);
    h.editor.moveBlocksDown();
    replaceAiAnswer(h, read(h, 'New.'), cover(h), WRITABLE);
    const words = blocks(h).map(textOf);
    expect(words.at(-1)).toBe('After.');
    expect(words.filter((w) => w === 'After.')).toHaveLength(1);
    expect(words).not.toContain('');
  });

  it('hangs the last block\'s children under the last result block, their ids kept', async () => {
    const h = await open('Para one.\n\n- last\n  - child');
    const child = flat(h).find((b) => textOf(b) === 'child')!;
    replaceWith(h, { from: rangeOf(h, 'Para').from, to: rangeOf(h, 'last').to }, () => 'X\n\nY');
    expect(blocks(h).map(textOf)).toEqual(['X', 'Y']);
    expect(blocks(h)[1]!.children.map((b) => [b.id, textOf(b)])).toEqual([[child.id, 'child']]);
    const ids = flat(h).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('replaces a whole table the selection runs into from outside', async () => {
    const h = await open('Before\n\n| a | b |\n| --- | --- |\n| c | d |\n\nAfter');
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'c').to }, () => 'Only words.');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'Only words.'], ['paragraph', 'After']]);
  });
});

describe('replace, open slice (§5.3, Plate openStart/openEnd)', () => {
  it('writes one answer block into the selected words, the rest of the block kept', async () => {
    const h = await open('Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), () => 'X Y Z');
    expect(blocks(h).map(textOf)).toEqual(['Intro: X Y Z end.']);
  });

  it('joins the first answer block to the words before and the words after to the last one', async () => {
    const h = await open('Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), () => 'A\n\nB');
    expect(blocks(h).map(textOf)).toEqual(['Intro: A', 'B end.']);
  });

  it('keeps the original kind before and the answer\'s own kind after', async () => {
    const h = await open('## Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), () => 'A\n\nB');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['heading', 'Intro: A'], ['paragraph', 'B end.']]);
  });

  it('lands an answer opening with a code block on its own, the words before kept apart', async () => {
    const h = await open('Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), () => '```js\nconst a = 1;\n```\n\nB');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'Intro: '],
      ['codeBlock', 'const a = 1;'],
      ['paragraph', 'B end.'],
    ]);
  });

  it('keeps the words after out of an answer ending with a code block', async () => {
    const h = await open('Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), () => 'A\n\n```js\nconst a = 1;\n```');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'Intro: A'],
      ['codeBlock', 'const a = 1;'],
      ['paragraph', ' end.'],
    ]);
  });

  it('pastes over a list item and its sub-item, the later sub-item left in place, no empty block', async () => {
    const h = await open('- parent\n  - kid\n  - kid two\n- after');
    replaceWith(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'kid').to }, () => 'A\n\nB');
    const all = flat(h);
    expect(all.map(textOf)).toEqual(['A', 'B', 'kid two', 'after']);
    expect(all.every((b) => textOf(b) !== '')).toBe(true);
  });

  it('changes only the words inside one docTable cell, rows and columns unchanged', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c d | e |');
    replaceWith(h, rangeOf(h, 'd'), () => 'D');
    expect(docCells(blocks(h)[0]!)).toEqual([['a', 'b'], ['c D', 'e']]);
  });

  it('keeps a legacy cell when its words are replaced', async () => {
    const h = await open('');
    legacyTable(h, [['one two', 'y']]);
    replaceWith(h, rangeOf(h, 'two'), () => 'TWO');
    expect(legacyCells(h)).toEqual([['one TWO', 'y']]);
  });
});

describe('edits while the dialog is open (A6, A7)', () => {
  it('replaces the range after Enter and typing inside it', async () => {
    const h = await open('Before.\n\nOne two.\n\nThree four.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One').from, to: rangeOf(h, 'four.').to });
    h.editor.prosemirrorView!.dispatch(h.editor.prosemirrorState.tr.split(rangeOf(h, 'two').from));
    type(h, rangeOf(h, 'Three').from, 'typed ');
    replaceAiAnswer(h, read(h, 'New.'), cover(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Before.', 'New.', 'After.']);
  });

  it('has nothing to cover once every word of the range is deleted', async () => {
    const h = await open('Keep. Gone. Keep.');
    capture(h, rangeOf(h, 'Gone.'));
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'Gone.');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    expect(cover(h)).toBeNull();
  });
});

describe('insert (§5.3)', () => {
  it('puts exactly the preview blocks under the insert block, the body before it unchanged', async () => {
    const h = await open('one\n\ntwo\n\nafter');
    capture(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to });
    const answer = read(h, '- a\n\nb');
    expect(insertAiAnswer(h, blocks(h)[1]!.id, answer, WRITABLE).outcome).toBe('written');
    expect(blocks(h).map(textOf)).toEqual(['one', 'two', 'a', 'b', 'after']);
    expect(blocks(h).slice(2, 4).map(idless)).toEqual(answer.preview.map(idless));
  });

  it('inserts nothing once the insert block is gone', async () => {
    const h = await open('One.\n\nTwo.');
    capture(h, rangeOf(h, 'Two.'));
    const target = blocks(h)[1]!.id;
    const answer = read(h, 'Three.');
    h.editor.removeBlocks([target]);
    expect(insertAiAnswer(h, target, answer, WRITABLE)).toEqual({ outcome: 'targetGone' });
  });
});

describe('writing as an ordinary edit (A6)', () => {
  it('replaces as one undo step, apart from the typing just before and just after', async () => {
    const h = await open('The quick brown fox.');
    type(h, rangeOf(h, 'fox.').to, ' Jumps.');
    replaceWith(h, rangeOf(h, 'quick brown'), () => 'slow red');
    type(h, rangeOf(h, 'Jumps.').to, ' Again.');
    expect(blocks(h).map(textOf)).toEqual(['The slow red fox. Jumps. Again.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['The slow red fox. Jumps.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['The quick brown fox. Jumps.']);
  });

  it('inserts as one undo step, apart from the typing just before and just after', async () => {
    const h = await open('Typed here.\n\nTarget.');
    type(h, rangeOf(h, 'Typed here.').to, ' More');
    capture(h, rangeOf(h, 'Target.'));
    insertAiAnswer(h, blocks(h)[1]!.id, read(h, 'Inserted.'), WRITABLE);
    type(h, rangeOf(h, 'Target.').to, ' Later');
    expect(blocks(h).map(textOf)).toEqual(['Typed here. More', 'Target. Later', 'Inserted.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['Typed here. More', 'Target.', 'Inserted.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['Typed here. More', 'Target.']);
  });

  it.each([
    ['denied', 'readOnly'],
    ['unknown', 'failed'],
  ] as const)('writes nothing while the connection says %s', async (writeAccess, outcome) => {
    const h = await open('One.');
    capture(h, rangeOf(h, 'One.'));
    const answer = read(h, 'Two.');
    const admission = (): ProposalAdmission => ({ available: true, writeAccess });
    expect(replaceAiAnswer(h, answer, cover(h), admission)).toEqual({ outcome });
    expect(insertAiAnswer(h, blocks(h)[0]!.id, answer, admission)).toEqual({ outcome });
    expect(blocks(h).map(textOf)).toEqual(['One.']);
  });
});
