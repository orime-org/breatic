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
import type { DecorationSet } from '@tiptap/pm/view';

import { aiCapture } from '@web/spaces/document/document-ai-launch';
import { aiCoverIn, containerAt, DOCUMENT_AI_RANGE, ownContentEnd } from '@web/spaces/document/document-ai-range';
import {
  aiAnswer,
  aiAnswerEmpty,
  aiRequest,
  insertAiAnswer,
  replaceAiAnswer,
  type AiAnswer,
} from '@web/spaces/document/document-ai-text';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import type { LocalRange } from '@web/spaces/document/document-local-range';
import { blockById, type ProposalAdmission } from '@web/spaces/document/document-proposal-landing';

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
  insertBlocks.set(handle, captured!.insertId);
  view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, captured));
}

/** The insert block each open dialog took when it opened, as the dialog keeps it. */
const insertBlocks = new WeakMap<DocumentEditorHandle, string | null>();

/**
 * The insert block the open dialog took.
 * @param handle - The document.
 * @returns Its id.
 */
function insertBlock(handle: DocumentEditorHandle): string | null {
  return insertBlocks.get(handle) ?? null;
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
  return aiAnswer(handle.editor, handle.editor.prosemirrorState, text, OURS, insertBlock(handle)!);
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
  expect(replaceAiAnswer(handle, answer, WRITABLE).outcome).toBe('written');
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

/**
 * The words of the block a block hangs under.
 * @param handle - The document.
 * @param words - The block's words.
 * @returns Its parent's words; null at the top or when there is no such block.
 */
function parentWords(handle: DocumentEditorHandle, words: string): string | null {
  const walk = (list: Seen[], parent: Seen | null): string | null | undefined => {
    for (const b of list) {
      if (textOf(b) === words) return parent === null ? null : textOf(parent);
      const found = walk(b.children, b);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(blocks(handle), null) ?? null;
}

/**
 * Whether every block id in the body is its own.
 * @param handle - The document.
 * @returns True when none repeats.
 */
function idsUnique(handle: DocumentEditorHandle): boolean {
  const ids = flat(handle).map((b) => b.id);
  return new Set(ids).size === ids.length;
}

/**
 * The inline content of each block in the second row's first cell of the second block's table.
 * @param handle - The document.
 * @returns Each block's content.
 */
function cellContents(handle: DocumentEditorHandle): unknown[] {
  return blocks(handle)[1]!.children[1]!.children[0]!.children.map((b) => b.content);
}

/**
 * The words the open range is painted over, one entry per painted stretch.
 * @param handle - The document.
 * @returns The words.
 */
function painted(handle: DocumentEditorHandle): string[] {
  return [...handle.editor.prosemirrorView!.dom.querySelectorAll('[data-show-selection]')].map((e) => e.textContent ?? '');
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

  it('sends a sub-item and the next top-level block as the whole blocks they are', async () => {
    const h = await open('- parent\n  - kid\n- next item\n\nAfter.');
    capture(h, { from: rangeOf(h, 'kid').from + 1, to: rangeOf(h, 'next').to });
    expect(request(h)).toBe('* kid\n* next item');
  });

  it('sends a whole legacy table for a selection from one of its cells into another', async () => {
    const h = await open('Before\n\nAfter');
    legacyTable(h, [['one', 'two'], ['three', 'four']]);
    capture(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'three').to });
    expect(request(h)).toContain('three');
    expect(request(h)).toContain('four');
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

  it('echoes code with backslashes in an HTML-form table cell unchanged', async () => {
    const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
    const cell = blocks(h)[1]!.children[1]!.children[0]!;
    h.editor.updateBlock(cell.children[0]!.id, { content: [{ type: 'text', text: 'C:\\dir \\\\x', styles: { code: true } }] } as never);
    h.editor.insertBlocks([{ type: 'codeBlock', content: 'a\\b & <c>' }] as never, cell.children[0]!.id, 'after');
    const before = docCells(blocks(h)[1]!);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(docCells(blocks(h)[1]!)).toEqual(before);
  });

  it('echoes a space after a hard break in an HTML-form table cell unchanged', async () => {
    const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
    const cell = blocks(h)[1]!.children[1]!.children[0]!;
    h.editor.updateBlock(cell.children[0]!.id, { content: 'a\n b' } as never);
    h.editor.insertBlocks([{ type: 'paragraph', content: 'second' }] as never, cell.children[0]!.id, 'after');
    const before = cellContents(h);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(cellContents(h)).toEqual(before);
  });

  it('echoes a link address with backslashes and entities in an HTML-form table cell unchanged', async () => {
    const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
    const cell = blocks(h)[1]!.children[1]!.children[0]!;
    h.editor.updateBlock(cell.children[0]!.id, { content: [{ type: 'link', href: 'https://e.com/\\>a&b&amp;\\\\c', content: 'a\\b' }] } as never);
    h.editor.insertBlocks([{ type: 'paragraph', content: 'second' }] as never, cell.children[0]!.id, 'after');
    const before = cellContents(h);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(cellContents(h)).toEqual(before);
  });

  it('echoes any words in an HTML-form table cell unchanged', async () => {
    const address = fc.string({ unit: fc.constantFrom('a', '\\', '&', ';', '#', '>', '(', ')', '%', '1'), minLength: 1, maxLength: 8 });
    const piece = fc.record({
      text: fc.string({ unit: fc.constantFrom(...TRICKY), minLength: 1, maxLength: 10 }),
      style: fc.constantFrom({}, { code: true }, { bold: true }, { italic: true }),
      href: fc.option(address, { nil: null }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { minLength: 1, maxLength: 3 }), async (pieces) => {
        fc.pre(pieces.some((x) => /\S/.test(x.text)));
        const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
        const cell = blocks(h)[1]!.children[1]!.children[0]!;
        const content = pieces.map((x) => (x.href === null
          ? { type: 'text', text: x.text, styles: x.style }
          : { type: 'link', href: `https://e.com/${x.href}`, content: [{ type: 'text', text: x.text, styles: x.style }] }));
        h.editor.updateBlock(cell.children[0]!.id, { content } as never);
        h.editor.insertBlocks([{ type: 'paragraph', content: 'second' }] as never, cell.children[0]!.id, 'after');
        // Only documents the body's schema holds (code takes no other mark, a link included).
        let valid = true;
        try {
          h.editor.prosemirrorState.doc.check();
        } catch {
          valid = false;
        }
        fc.pre(valid);
        const before = cellContents(h);
        replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
        expect(cellContents(h)).toEqual(before);
        _resetDocumentEditorCacheForTests();
        document.body.innerHTML = '';
      }),
      { numRuns: 80 },
    );
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

  it('echoes a code block whose code holds a fence unchanged', async () => {
    const h = await openBlocks([{ type: 'codeBlock', props: { language: 'markdown' }, content: '```js\nconst a = 1;\n```' }, { type: 'paragraph', content: 'Next.' }]);
    replaceWith(h, contentOf(h, blocks(h)[0]!.id), (sent) => sent);
    replaceWith(h, { from: contentOf(h, blocks(h)[0]!.id).from, to: rangeOf(h, 'Next.').to }, (sent) => sent);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', '```js\nconst a = 1;\n```'], ['paragraph', 'Next.']]);
  });

  it('echoes inline code holding a backslash and a pipe in a pipe-table cell unchanged', async () => {
    const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
    const cell = blocks(h)[1]!.children[1]!.children[0]!;
    h.editor.updateBlock(cell.children[0]!.id, { content: [{ type: 'text', text: 'a\\|b', styles: { code: true } }] } as never);
    const before = cellContents(h);
    replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
    expect(cellContents(h)).toEqual(before);
    expect(docCells(blocks(h)[1]!)).toEqual([['h', 'k'], ['a\\|b', 'q']]);
  });

  it('echoes any code in a code block and in a pipe-table cell unchanged', async () => {
    const code = fc.string({ unit: fc.constantFrom('a', ' ', '\n', '`', '```', '\\', '|', '&', '<', '#', '*', '~~~'), minLength: 1, maxLength: 12 });
    await fc.assert(
      fc.asyncProperty(code, fc.boolean(), async (words, inBlock) => {
        fc.pre(/\S/.test(words));
        const h = await open('Before\n\n| h | k |\n| --- | --- |\n| p | q |\n\nAfter');
        if (inBlock) {
          h.editor.insertBlocks([{ type: 'codeBlock', content: words }] as never, blocks(h)[0]!.id, 'after');
        } else {
          const cell = blocks(h)[1]!.children[1]!.children[0]!;
          fc.pre(!words.includes('\n'));
          h.editor.updateBlock(cell.children[0]!.id, { content: [{ type: 'text', text: words, styles: { code: true } }] } as never);
        }
        const before = readingOrder(h).map(([, type, text]) => [type, text]);
        replaceWith(h, { from: rangeOf(h, 'Before').from, to: rangeOf(h, 'After').to }, (sent) => sent);
        expect(readingOrder(h).map(([, type, text]) => [type, text])).toEqual(before);
        _resetDocumentEditorCacheForTests();
        document.body.innerHTML = '';
      }),
      { numRuns: 120 },
    );
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

  it('echoes two italic links side by side unchanged', async () => {
    const h = await openBlocks([{ type: 'paragraph', content: [
      { type: 'text', text: 'see ', styles: {} },
      { type: 'link', href: 'https://en.wikipedia.org/wiki/A', content: [{ type: 'text', text: 'Foo', styles: { italic: true } }] },
      { type: 'link', href: 'https://x.com/b/', content: [{ type: 'text', text: 'Bar', styles: { italic: true } }] },
      { type: 'text', text: ' after', styles: {} },
    ] }, { type: 'paragraph', content: 'Next.' }]);
    const before = blocks(h)[0]!.content;
    replaceWith(h, { from: rangeOf(h, 'see').from, to: rangeOf(h, 'Next.').to }, (sent) => sent);
    expect(blocks(h)[0]!.content).toEqual(before);
  });

  it('echoes an emphasised link whose address holds emphasis marks unchanged', async () => {
    const h = await openBlocks([{ type: 'paragraph', content: [
      { type: 'text', text: 'see ', styles: {} },
      { type: 'link', href: 'https://x.com/a*b~~c', content: [{ type: 'text', text: 'wiki', styles: { italic: true } }] },
      { type: 'text', text: ' after', styles: {} },
    ] }, { type: 'paragraph', content: 'Next.' }]);
    const before = blocks(h)[0]!.content;
    replaceWith(h, { from: rangeOf(h, 'see').from, to: rangeOf(h, 'Next.').to }, (sent) => sent);
    expect(blocks(h)[0]!.content).toEqual(before);
  });

  it('echoes any styled words and links in paragraphs, headings and list items unchanged', async () => {
    const punctuation = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'];
    const style = fc.constantFrom({}, { bold: true }, { italic: true }, { strike: true }, { code: true }, { bold: true, italic: true });
    const piece = fc.record({
      text: fc.string({ unit: fc.constantFrom('a', 'b', ' ', '*', '_', '~', '[', ']', '(', ')', '\\', '&', '<', '`'), minLength: 1, maxLength: 6 }),
      style,
      href: fc.option(fc.string({ unit: fc.constantFrom('a', ...punctuation), minLength: 1, maxLength: 5 }), { nil: null }),
    });
    const block = fc.record({ type: fc.constantFrom('paragraph', 'heading', 'bulletListItem'), pieces: fc.array(piece, { minLength: 1, maxLength: 4 }) });
    await fc.assert(
      fc.asyncProperty(block, async ({ type, pieces }) => {
        fc.pre(pieces.some((x) => /\S/.test(x.text)));
        // Plain words first: 'single' puts the first words' styles under the whole first block.
        const content = [{ type: 'text', text: 'Lead ', styles: {} }, ...pieces.map((x) => (x.href === null
          ? { type: 'text', text: x.text, styles: x.style }
          : { type: 'link', href: `https://x.com/${x.href}`, content: [{ type: 'text', text: x.text, styles: x.style }] }))];
        let h: DocumentEditorHandle;
        try {
          h = await openBlocks([{ type, content }, { type: 'paragraph', content: 'Next.' }]);
        } catch {
          // Code takes no other mark, a link included: not a document the body holds.
          fc.pre(false);
          return;
        }
        const before = blocks(h)[0]!.content;
        replaceWith(h, { from: contentOf(h, blocks(h)[0]!.id).from, to: rangeOf(h, 'Next.').to }, (sent) => sent);
        expect(blocks(h)[0]!.content).toEqual(before);
        _resetDocumentEditorCacheForTests();
        document.body.innerHTML = '';
      }),
      { numRuns: 150 },
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
    expect(replaceAiAnswer(h, answer, WRITABLE).outcome).toBe('written');
    expect(blocks(h)[0]!.type).toBe(kind);
  });

  it('writes a paragraph answer for whole blocks starting with a code block as a paragraph', async () => {
    const h = await open('```js\nconst a = 1;\n```\n\nNext.');
    capture(h, { from: rangeOf(h, 'const').from, to: rangeOf(h, 'Next.').to });
    const preview = read(h, 'It sets **a** to one.').preview as Seen[];
    expect(preview[0]!.type).toBe('paragraph');
    expect((preview[0]!.content as Piece[]).map((c) => c.styles)).toEqual([{}, { bold: true }, {}]);
  });

  it('writes a valid body when the range\'s first words are inline code and the answer has emphasis or a link', async () => {
    for (const text of ['the **dependencies**', '[link](https://x.example/) tail', '*it* ~~st~~']) {
      const h = await open('`npm install` installs the deps\n\nsecond two');
      capture(h, rangeOf(h, 'installs'));
      expect(replaceAiAnswer(h, read(h, text), WRITABLE).outcome).toBe('written');
      expect(() => h.editor.prosemirrorState.doc.check()).not.toThrow();
      const h2 = await open('`npm install` installs the deps\n\nsecond two');
      capture(h2, { from: rangeOf(h2, 'installs').from, to: rangeOf(h2, 'two').to });
      expect(insertAiAnswer(h2, insertBlock(h2)!, read(h2, text), WRITABLE).outcome).toBe('written');
      expect(() => h2.editor.prosemirrorState.doc.check()).not.toThrow();
    }
  });

  it('unfolds a table answered inside a docTable cell, the outer table unchanged', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | d |');
    replaceWith(h, rangeOf(h, 'c'), () => '| p | q |\n| --- | --- |\n| r | s |');
    const tables = flat(h).filter((b) => b.type === 'docTable');
    expect(tables).toHaveLength(1);
    expect(tables[0]!.children.map((row) => row.children.length)).toEqual([2, 2]);
  });

  it('unfolds a table answered for whole blocks in a cell once the insert block is gone', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | d |');
    const c = flat(h).find((b) => textOf(b) === 'c')!;
    h.editor.insertBlocks([{ type: 'paragraph', content: 'c2' }] as never, c.id, 'after');
    capture(h, { from: rangeOf(h, 'c').from, to: rangeOf(h, 'c2').to });
    h.editor.removeBlocks([insertBlock(h)!]);
    const answer = read(h, '| x | y |\n| --- | --- |\n| z | w |');
    expect((answer.preview as Seen[]).some((b) => b.type === 'docTable')).toBe(false);
    expect(replaceAiAnswer(h, answer, WRITABLE).outcome).toBe('written');
    expect(flat(h).filter((b) => b.type === 'docTable')).toHaveLength(1);
  });

  it('leaves a legacy cell\'s words when the answer holds only an outside image, and counts it', async () => {
    const h = await open('next');
    legacyTable(h, [['one two', 'y']]);
    capture(h, rangeOf(h, 'two'));
    const answer = read(h, '![i](https://elsewhere.example/x.png)');
    expect(answer).toEqual({ preview: [], leftOut: 1 });
    expect(replaceAiAnswer(h, answer, WRITABLE)).toEqual({ outcome: 'nothingWritten', leftOut: 1 });
    expect(legacyCells(h)).toEqual([['one two', 'y']]);
  });

  it('writes nothing into a legacy cell for an answer of only a table, by replace or insert alike', async () => {
    const h = await open('next');
    legacyTable(h, [['one two', 'y']]);
    capture(h, rangeOf(h, 'two'));
    const answer = read(h, '| a | b |\n| --- | --- |\n| c | d |');
    const count = flat(h).length;
    expect(replaceAiAnswer(h, answer, WRITABLE)).toEqual({ outcome: 'nothingWritten', leftOut: 0 });
    expect(insertAiAnswer(h, insertBlock(h)!, answer, WRITABLE)).toEqual({ outcome: 'nothingWritten', leftOut: 0 });
    expect([legacyCells(h), flat(h).length]).toEqual([[['one two', 'y']], count]);
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

  it('overwrites images at the edges of the range and an empty line inside it, undo bringing them back', async () => {
    const h = await openBlocks([
      { type: 'paragraph', content: 'Before.' },
      { type: 'image', props: { url: `${OURS}a.png` } },
      { type: 'paragraph', content: 'Middle.' },
      { type: 'paragraph' },
      { type: 'image', props: { url: `${OURS}b.png` } },
      { type: 'paragraph', content: 'After.' },
    ]);
    // From the end of "Before." to just past the second image: a range
    // starting at the end of a block leaves that block out, so the first
    // image comes first.
    replaceWith(h, { from: rangeOf(h, 'Before.').to, to: contentOf(h, blocks(h)[4]!.id).to }, () => 'Rewritten.');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'Before.'], ['paragraph', 'Rewritten.'], ['paragraph', 'After.']]);
    h.undoManager.undo();
    expect(blocks(h).map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph', 'paragraph', 'image', 'paragraph']);
  });

  it('covers from the block of the first tracked word once the first block was deleted', async () => {
    const h = await open('One.\n\nTwo.\n\nThree.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One.').from, to: rangeOf(h, 'Three.').to });
    h.editor.removeBlocks([blocks(h)[0]!.id]);
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['New.', 'After.']);
  });

  it('leaves the body outside the range alone once the first block was moved past the last', async () => {
    const h = await open('One.\n\nTwo.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One.').from, to: rangeOf(h, 'Two.').to });
    h.editor.setTextCursorPosition(blocks(h)[0]!.id);
    h.editor.moveBlocksDown();
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
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

  it('pastes over a list item and its sub-item, the later sub-item left in place, no empty block', async () => {
    const h = await open('- parent\n  - kid\n  - kid two\n- after');
    replaceWith(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'kid').to }, () => 'A\n\nB');
    const all = flat(h);
    expect(all.map(textOf)).toEqual(['A', 'B', 'kid two', 'after']);
    expect(all.every((b) => textOf(b) !== '')).toBe(true);
  });

  it('writes whole blocks of different levels from a code block as the preview, a paragraph staying a paragraph', async () => {
    const h = await open('```js\nconst a = 1;\n```\n\n- parent\n  - kid\n\nAfter');
    const answer = replaceWith(h, { from: rangeOf(h, 'const').from, to: rangeOf(h, 'kid').to }, () => 'Plain words.\n\nSecond.');
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'Plain words.'], ['paragraph', 'Second.'], ['paragraph', 'After']]);
    expect(blocks(h).slice(0, 2).map(idless)).toEqual(answer.preview.map(idless));
  });

  it('lands an answer opening with a code block over whole blocks of different levels, no empty block before it', async () => {
    const h = await open('Para one.\n\n- parent\n  - kid\n\nAfter');
    replaceWith(h, { from: rangeOf(h, 'Para').from, to: rangeOf(h, 'kid').to }, () => '```js\nx = 1\n```\n\nTail.');
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', 'x = 1'], ['paragraph', 'Tail.'], ['paragraph', 'After']]);
  });

  it('writes an answer that keeps a code block and a nested list over them as it reads', async () => {
    const h = await open('Before.\n\n```js\nconst a = 1;\n```\n\n- parent\n  - kid\n\nAfter');
    replaceWith(h, { from: rangeOf(h, 'const').from, to: rangeOf(h, 'kid').to }, (sent) => sent.replace('parent', 'Parent').replace('kid', 'Kid'));
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'Before.'],
      ['codeBlock', 'const a = 1;'],
      ['bulletListItem', 'Parent'],
      ['bulletListItem', 'Kid'],
      ['paragraph', 'After'],
    ]);
    expect(parentWords(h, 'Kid')).toBe('Parent');
  });

  it('hangs the last block\'s sub-items under the answer\'s last block across levels, no empty block', async () => {
    const h = await open('- item one\n  - sub one\n    - subsub');
    replaceWith(h, { from: rangeOf(h, 'item one').from, to: rangeOf(h, 'sub one').to }, () => 'X\n\nY');
    expect(flat(h).map(textOf)).toEqual(['X', 'Y', 'subsub']);
    expect(parentWords(h, 'subsub')).toBe('Y');
    expect(idsUnique(h)).toBe(true);
  });

  it('keeps the blocks after the range in their order and level across levels', async () => {
    const h = await open('- a\n  - b\n    - c\n  - d');
    replaceWith(h, { from: rangeOf(h, 'a').from, to: rangeOf(h, 'b').to }, () => 'Z');
    expect(flat(h).map(textOf)).toEqual(['Z', 'c', 'd']);
    expect([parentWords(h, 'c'), parentWords(h, 'd')]).toEqual(['Z', 'Z']);
    expect(idsUnique(h)).toBe(true);
  });

  it('keeps the children and later sub-items in their order under an answer of two blocks', async () => {
    const h = await open('- p\n  - k\n    - g\n  - k2');
    replaceWith(h, { from: rangeOf(h, 'p').from, to: rangeOf(h, 'k').to }, () => 'X\n\nY');
    expect(flat(h).map(textOf)).toEqual(['X', 'Y', 'g', 'k2']);
    expect([parentWords(h, 'g'), parentWords(h, 'k2')]).toEqual(['Y', 'Y']);
  });

  it('keeps blocks that were siblings as siblings after one of them is lifted', async () => {
    const h = await open('- one\n  - two\n    - three\n    - four\n- end');
    replaceWith(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, () => '- New');
    expect(flat(h).map(textOf)).toEqual(['New', 'three', 'four', 'end']);
    expect([parentWords(h, 'three'), parentWords(h, 'four')]).toEqual(['New', 'New']);
  });

  it('keeps an uncle after a lifted grandchild at its own level', async () => {
    const h = await open('- alpha\n  - kid\n    - grand\n      - g3\n    - s2\n  - s1');
    replaceWith(h, { from: rangeOf(h, 'alpha').from, to: rangeOf(h, 'grand').to }, () => 'X');
    expect([parentWords(h, 'g3'), parentWords(h, 's2'), parentWords(h, 's1')]).toEqual(['X', 'X', 'X']);
  });

  it('leaves no copy of the covered blocks when the answer is only a code block', async () => {
    const h = await open('- p\n  - k\n  - k2\n\nAfter');
    const covered = flat(h).slice(0, 2).map((b) => b.id);
    replaceWith(h, { from: rangeOf(h, 'p').from, to: rangeOf(h, 'k').to }, () => '```js\nq\n```');
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', 'q'], ['bulletListItem', 'k2'], ['paragraph', 'After']]);
    expect(flat(h).some((b) => covered.includes(b.id))).toBe(false);
    expect(parentWords(h, 'k2')).toBe('q');
  });

  it('leaves no copy of the covered blocks when the answer ends with a code block, later items kept', async () => {
    const h = await open('- parent\n  - kid\n  - kid two\n- after');
    replaceWith(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'kid').to }, () => 'A\n\n```js\nc\n```');
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['bulletListItem', 'A'],
      ['codeBlock', 'c'],
      ['bulletListItem', 'kid two'],
      ['bulletListItem', 'after'],
    ]);
    expect(parentWords(h, 'kid two')).toBe('c');
  });

  it('writes whole blocks across levels whose last has children when the answer ends with a code block', async () => {
    const h = await open('- item one\n  - sub one\n    - subsub\n\nAfter');
    replaceWith(h, { from: rangeOf(h, 'item one').from, to: rangeOf(h, 'sub one').to }, () => 'X\n\n```js\nc\n```');
    expect(flat(h).map(textOf)).toEqual(['X', 'c', 'subsub', 'After']);
    expect(parentWords(h, 'subsub')).toBe('c');
    expect(idsUnique(h)).toBe(true);
  });

  it('keeps a later block at its level when the range starts deeper than it ends', async () => {
    const h = await open('- a\n  - b\n- c\n  - d');
    replaceWith(h, { from: rangeOf(h, 'b').from, to: rangeOf(h, 'c').to }, () => 'Z');
    expect(flat(h).map(textOf)).toEqual(['a', 'Z', 'd']);
    expect([parentWords(h, 'Z'), parentWords(h, 'd')]).toEqual(['a', 'a']);
  });
});

/** A block's shape for the generated documents. */
interface Shape {
  kind: 'paragraph' | 'heading' | 'bulletListItem' | 'numberedListItem' | 'codeBlock' | 'image' | 'docTable';
  children: Shape[];
}

/**
 * Generated blocks, a few levels deep.
 * @param depth - How many levels may follow.
 * @returns The arbitrary.
 */
function shapes(depth: number): fc.Arbitrary<Shape[]> {
  const kind = fc.constantFrom<Shape['kind']>('paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'codeBlock', 'image', 'docTable');
  return fc.array(fc.record({ kind, children: depth > 0 ? shapes(depth - 1) : fc.constant<Shape[]>([]) }), { minLength: 1, maxLength: 3 });
}

/**
 * Blocks for the block API from shapes, each holding words of its own.
 * @param parser - An editor, for the tables.
 * @param list - The shapes.
 * @param next - The next word number.
 * @returns The blocks.
 */
function shaped(parser: DocumentEditorHandle['editor'], list: readonly Shape[], next: { n: number }): unknown[] {
  return list.map((shape) => {
    next.n += 1;
    const w = `w${String(next.n)}x`;
    if (shape.kind === 'docTable') return parser.tryParseMarkdownToBlocks(`| ${w}a | ${w}b |\n| --- | --- |\n| ${w}c | ${w}d |`)[0];
    const children = shaped(parser, shape.children, next);
    if (shape.kind === 'image') return { type: 'image', props: { url: `${OURS}i.png` }, children };
    // First words of every kind 'single' carries: plain, emphasis, inline code, a link.
    const lead = [{}, { bold: true }, { code: true }, null][next.n % 4];
    if (shape.kind === 'codeBlock' || lead === undefined) return { type: shape.kind, content: w, children };
    const first = lead === null ? { type: 'link', href: 'https://x.example/', content: 'lk' } : { type: 'text', text: 'lead ', styles: lead };
    return { type: shape.kind, content: [first, { type: 'text', text: ` ${w}`, styles: {} }], children };
  });
}

/**
 * Every block in reading order with the words it holds, tables as one block.
 * @param handle - The document.
 * @returns Each block's id, kind and words.
 */
function readingOrder(handle: DocumentEditorHandle): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const walk = (list: Seen[]): void => {
    for (const b of list) {
      out.push([b.id, b.type, b.type === 'docTable' ? JSON.stringify(docCells(b)) : textOf(b)]);
      if (b.type !== 'docTable') walk(b.children);
    }
  };
  walk(blocks(handle));
  return out;
}

/**
 * Blocks as the block API takes them, in reading order with their words, tables as one block.
 * @param list - The blocks.
 * @returns Each block's kind and words.
 */
function readingOrderOf(list: readonly Seen[]): Array<[string, string]> {
  return list.flatMap((b): Array<[string, string]> => [
    [b.type, b.type === 'docTable' ? JSON.stringify(docCells(b)) : textOf(b)],
    ...(b.type === 'docTable' ? [] : readingOrderOf(b.children ?? [])),
  ]);
}

/**
 * Whether a position stands inside a docTable.
 * @param $pos - The position.
 * @returns True inside one.
 */
function inTable($pos: { depth: number; node: (depth: number) => { type: { name: string } } }): boolean {
  for (let depth = 1; depth <= $pos.depth; depth += 1) if ($pos.node(depth).type.name === 'docTable') return true;
  return false;
}

/**
 * Each block's parent, tables read as one block.
 * @param handle - The document.
 * @returns Block id to parent id; the top level as an empty string.
 */
function parentsOf(handle: DocumentEditorHandle): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: Seen[], parent: string): void => {
    for (const b of list) {
      out.set(b.id, parent);
      if (b.type !== 'docTable') walk(b.children, b.id);
    }
  };
  walk(blocks(handle), '');
  return out;
}

/** Answers of every shape at their edges: words, code, a nested list, a table, an image. */
const ANSWERS = [
  'X',
  'X\n\nY',
  '```js\nq\n```',
  'X\n\n```js\nq\n```',
  '```js\nq\n```\n\nX',
  '- A\n  - B',
  'X\n\n- A\n  - B',
  '| a | b |\n| --- | --- |\n| c | d |',
  'X\n\n| a | b |\n| --- | --- |\n| c | d |',
  `X\n\n![i](${OURS}j.png)`,
  'X **b** [l](https://x.example/) ~~s~~',
];

/** An edit made while the dialog is open: a character typed or deleted, Enter, Backspace joining two blocks, a block deleted or moved. */
interface Edit {
  kind: 'none' | 'type' | 'delete' | 'split' | 'join' | 'remove' | 'move';
  at: number;
  to: number;
}

/**
 * Makes an edit the way the body would, skipping one the schema refuses.
 * @param handle - The document.
 * @param edit - The edit.
 * @param spots - Every position inside a line of words.
 */
function edited(handle: DocumentEditorHandle, edit: Edit, spots: readonly number[]): void {
  const view = handle.editor.prosemirrorView!;
  const { doc } = view.state;
  const blockAt: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') blockAt.push(pos);
    return true;
  });
  const at = spots[edit.at % spots.length]!;
  const $at = doc.resolve(at);
  const tr = view.state.tr;
  try {
    if (edit.kind === 'type') tr.insertText('z', at);
    else if (edit.kind === 'delete' && at > $at.start()) tr.delete(at - 1, at);
    else if (edit.kind === 'split' && $at.node($at.depth - 1).type.name === 'blockContainer' && $at.parent.type.name !== 'codeBlock') tr.split(at, 2);
    else if (edit.kind === 'join') tr.join(blockAt[edit.at % blockAt.length]!, 2);
    else if (edit.kind === 'remove') tr.delete(blockAt[edit.at % blockAt.length]!, blockAt[edit.at % blockAt.length]! + doc.nodeAt(blockAt[edit.at % blockAt.length]!)!.nodeSize);
    else if (edit.kind === 'move') {
      const from = blockAt[edit.at % blockAt.length]!;
      const node = doc.nodeAt(from)!;
      const target = blockAt[edit.to % blockAt.length]!;
      if (target > from && target < from + node.nodeSize) return;
      tr.delete(from, from + node.nodeSize);
      tr.insert(tr.mapping.map(target), node);
    }
    tr.doc.check();
  } catch {
    return;
  }
  if (tr.docChanged) view.dispatch(tr);
}

describe('replace and insert keep what is outside the range (§8 property)', () => {
  it('keeps every block outside the range in order and writes the preview, under any selection, edit and answer', async () => {
    const edit = fc.record({ kind: fc.constantFrom<Edit['kind']>('none', 'type', 'delete', 'split', 'join', 'remove', 'move'), at: fc.nat(), to: fc.nat() });
    await fc.assert(
      fc.asyncProperty(shapes(2), fc.nat(), fc.nat(), edit, fc.constantFrom(...ANSWERS), fc.boolean(), async (list, a, b, change, text, inserting) => {
        const h = await open('');
        h.editor.replaceBlocks(h.editor.document, shaped(h.editor, list, { n: 0 }) as never);
        h.undoManager.clear();
        const view = h.editor.prosemirrorView!;
        /**
         * Every position inside a line of words.
         * @returns The positions.
         */
        const spots = (): number[] => {
          const out: number[] = [];
          view.state.doc.descendants((node, pos) => {
            if (node.isTextblock) for (let i = 0; i <= node.content.size; i += 1) out.push(pos + 1 + i);
            return true;
          });
          return out;
        };
        const all = spots();
        const [from, to] = [all[a % all.length]!, all[b % all.length]!].sort((x, y) => x - y);
        fc.pre(from! < to!);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from!, to!)));
        const captured = aiCapture(view.state);
        fc.pre(captured !== null);
        view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, captured));
        if (change.kind !== 'none') edited(h, change, spots());
        fc.pre(spots().length > 0);
        const before = readingOrder(h);
        const emptyBefore = new Set(flat(h).filter((x) => Array.isArray(x.content) && textOf(x) === '').map((x) => x.id));
        const answer = aiAnswer(h.editor, view.state, text, OURS, captured!.insertId);
        if (inserting) {
          fc.pre(blockById(view.state.doc, captured!.insertId) !== null);
          expect(insertAiAnswer(h, captured!.insertId, answer, WRITABLE).outcome).toBe('written');
          expect(() => view.state.doc.check()).not.toThrow();
          const after = readingOrder(h);
          const at = after.findIndex(([id]) => id === captured!.insertId);
          expect(after.slice(0, at + 1)).toEqual(before.slice(0, at + 1));
          expect(idsUnique(h)).toBe(true);
          _resetDocumentEditorCacheForTests();
          document.body.innerHTML = '';
          return;
        }
        const range = cover(h);
        fc.pre(range !== null);
        // What is painted is what replace covers.
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, spots()[0]!)));
        const paint = (DOCUMENT_AI_RANGE.get(view.state)!.props.decorations as (state: typeof view.state) => DecorationSet)(view.state);
        const shown = paint.find().filter((d) => (d as unknown as { type: { attrs?: Record<string, string> } }).type.attrs?.['data-show-selection'] === 'true');
        expect(shown.map((d) => [d.from, d.to])).toEqual([[range!.from, range!.to]]);
        const doc = view.state.doc;
        const touched = new Set<string>();
        const whole = new Set<string>();
        doc.descendants((node, pos) => {
          if (!node.type.isInGroup('bnBlock')) return true;
          const end = ownContentEnd(doc, pos);
          if (pos + 1 < range!.to && end > range!.from) touched.add(String(node.attrs['id']));
          if (range!.from <= pos && end <= range!.to) whole.add(String(node.attrs['id']));
          return node.type.name !== 'docTable';
        });
        // Whole blocks run from a block's start to a block's end; otherwise the
        // first line keeps its block, the answer joined into it (Plate's open slice).
        const $from = doc.resolve(range!.from);
        const $to = doc.resolve(range!.to);
        const isWhole = (!$from.parent.isTextblock || $from.parentOffset === 0) && (!$to.parent.isTextblock || range!.to === $to.end());
        const firstBlock = $from.parent.isTextblock ? containerAt(doc, range!.from)! : range!.from;
        if (!isWhole) whole.delete(String(doc.nodeAt(firstBlock)!.attrs['id']));
        const outside = before.filter(([id]) => !touched.has(id));
        const parentsBefore = parentsOf(h);
        expect(replaceAiAnswer(h, answer, WRITABLE).outcome).toBe('written');
        expect(() => view.state.doc.check()).not.toThrow();
        const after = readingOrder(h);
        expect(idsUnique(h)).toBe(true);
        const kept = new Set(outside.map(([id]) => id));
        expect(after.filter(([id]) => kept.has(id))).toEqual(outside);
        expect(after.some(([id]) => whole.has(id))).toBe(false);
        // Blocks that were siblings and both stay are siblings still.
        const parentsAfter = parentsOf(h);
        for (const [a] of outside) {
          for (const [b] of outside) {
            if (a < b && parentsBefore.get(a) === parentsBefore.get(b)) expect([a, parentsAfter.get(a)]).toEqual([a, parentsAfter.get(b)]);
          }
        }
        expect(flat(h).filter((x) => Array.isArray(x.content) && textOf(x) === '' && !emptyBefore.has(x.id))).toEqual([]);
        // Whole blocks: what took their place is the preview, block for block
        // (inside a cell the table is what reads as one block here).
        if (isWhole && !inTable($from)) {
          expect(after.filter(([id]) => !kept.has(id)).map(([, type, words]) => [type, words])).toEqual(readingOrderOf(answer.preview as Seen[]));
        }
        _resetDocumentEditorCacheForTests();
        document.body.innerHTML = '';
      }),
      { numRuns: 400 },
    );
  });
});

describe('replace, words inside one line (§5.3, Plate openTextBlock)', () => {
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

  it('joins the words after the range to the deepest last block of a nested list answer', async () => {
    const h = await open('Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), () => 'A\n\n- b\n  - c');
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'Intro: A'],
      ['bulletListItem', 'b'],
      ['bulletListItem', 'c end.'],
    ]);
  });

  it('keeps the sub-items of the block the words were in at their level after a nested answer, every id its own', async () => {
    const h = await open('- item one\n  - sub one\n- item two');
    const sub = flat(h)[1]!.id;
    replaceWith(h, rangeOf(h, 'one'), () => 'X\n\n- a\n  - b');
    expect(flat(h).map(textOf)).toEqual(['item X', 'a', 'b', 'sub one', 'item two']);
    expect([parentWords(h, 'b'), parentWords(h, 'sub one')]).toEqual(['a', 'a']);
    expect(flat(h)[3]!.id).toBe(sub);
    expect(idsUnique(h)).toBe(true);
  });

  it('keeps the sub-items with the words after the range when the answer ends with a code block', async () => {
    const h = await open('- Intro: x end.\n  - kid');
    replaceWith(h, rangeOf(h, 'x'), () => 'A\n\n```js\nc\n```');
    expect(flat(h).map(textOf)).toEqual(['Intro: A', 'c', ' end.', 'kid']);
    expect(parentWords(h, 'kid')).toBe(' end.');
    expect(idsUnique(h)).toBe(true);
  });

  it('hangs the sub-items under a closed last block when no words follow the range', async () => {
    const h = await open('- Intro: x\n  - kid');
    replaceWith(h, rangeOf(h, 'x'), () => 'A\n\n```js\nc\n```');
    expect(flat(h).map((b) => [b.type, textOf(b)])).toEqual([['bulletListItem', 'Intro: A'], ['codeBlock', 'c'], ['bulletListItem', 'kid']]);
    expect(parentWords(h, 'kid')).toBe('c');
    expect(idsUnique(h)).toBe(true);
  });

  it('puts the sub-items after a table the answer ends with, no words following', async () => {
    const h = await openBlocks([{ type: 'paragraph', content: 'P x', children: [{ type: 'paragraph', content: 'kid' }] }, { type: 'paragraph', content: 'After' }]);
    replaceWith(h, rangeOf(h, 'x'), () => '| a | b |\n| --- | --- |\n| c | d |');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'P '], ['docTable', ''], ['paragraph', 'kid'], ['paragraph', 'After']]);
  });

  it('keeps the sub-items under their own nested parent, before its later items, when no words follow', async () => {
    const h = await open('- P\n  - x a\n    - kid\n  - b\n\nAfter');
    replaceWith(h, rangeOf(h, ' a'), () => 'A\n\n```js\nc\n```');
    expect(flat(h).map(textOf)).toEqual(['P', 'xA', 'c', 'kid', 'b', 'After']);
    expect([parentWords(h, 'c'), parentWords(h, 'kid'), parentWords(h, 'b')]).toEqual(['P', 'c', 'P']);
  });

  it('keeps the words left after the range at their own line\'s level when the answer ends with a code block', async () => {
    const h = await open('- Parent.\n  - Child one.\n- Tail two.\n- End.');
    capture(h, { from: rangeOf(h, 'Child').from, to: rangeOf(h, 'two.').to });
    type(h, rangeOf(h, 'two.').to, ' zz');
    replaceAiAnswer(h, read(h, 'X\n\n```js\nq\n```'), WRITABLE);
    expect(flat(h).map(textOf)).toEqual(['Parent.', 'X', 'q', ' zz', 'End.']);
    expect([parentWords(h, 'X'), parentWords(h, ' zz')]).toEqual(['Parent.', null]);
  });

  it('keeps the words left after the range under their own parent when the range starts higher', async () => {
    const h = await open('- Parent one.\n  - Child two.\n    - grandkid\n- Tail.');
    capture(h, { from: rangeOf(h, 'Parent').from, to: rangeOf(h, 'two.').to });
    type(h, rangeOf(h, 'two.').to, ' zz');
    replaceAiAnswer(h, read(h, 'X\n\n```js\nq\n```'), WRITABLE);
    expect(flat(h).map(textOf)).toEqual(['X', 'q', ' zz', 'grandkid', 'Tail.']);
    expect([parentWords(h, ' zz'), parentWords(h, 'grandkid')]).toEqual(['q', ' zz']);
  });

  it('lands a list answered for words at a line\'s start as the preview shows it', async () => {
    const h = await open('x y z end.\n\nAfter.');
    capture(h, rangeOf(h, 'x y z'));
    const answer = read(h, '- A\n- B');
    expect((answer.preview as Seen[]).map((b) => b.type)).toEqual(['bulletListItem', 'bulletListItem']);
    replaceAiAnswer(h, answer, WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['bulletListItem', 'A'], ['bulletListItem', 'B end.'], ['paragraph', 'After.']]);
  });

  it('lands a paragraph answered for words at a heading\'s start as a paragraph, the heading\'s words after it', async () => {
    const h = await open('## x y z end\n\nAfter.');
    capture(h, rangeOf(h, 'x y z'));
    replaceAiAnswer(h, read(h, 'A\n\nB'), WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['heading', 'A'], ['paragraph', 'B end'], ['paragraph', 'After.']]);
  });

  it('lands an answer opening with a code block before a line whose words start the range, no empty block', async () => {
    const h = await open('x Intro\n\nAfter');
    replaceWith(h, rangeOf(h, 'x'), () => '```js\nc\n```\n\nT');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', 'c'], ['paragraph', 'T Intro'], ['paragraph', 'After']]);
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

describe('words inside a code block (§5.1, §5.3)', () => {
  it('sends a whole code block\'s selected words as code and reads the answer back as code', async () => {
    const h = await openBlocks([{ type: 'codeBlock', props: { language: 'js' }, content: '# not heading\n- x * y * z' }]);
    capture(h, contentOf(h, blocks(h)[0]!.id));
    expect(request(h)).toBe('# not heading\n- x * y * z');
    const answer = read(h, '# not heading\n- x * y * z');
    expect((answer.preview as Seen[]).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', '# not heading\n- x * y * z']]);
    replaceAiAnswer(h, answer, WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b), b.props['language']])).toEqual([['codeBlock', '# not heading\n- x * y * z', 'js']]);
  });

  it('reads an echoed answer back as the same code, the rest of the block kept', async () => {
    const code = 'def f():\n    # note *x* [l](u) & <b>\n    return 1\nend';
    const h = await openBlocks([{ type: 'codeBlock', props: { language: 'python' }, content: code }]);
    replaceWith(h, { from: rangeOf(h, '# note').from, to: rangeOf(h, 'return 1').to }, (sent) => sent);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', code]]);
  });

  it('takes the code out of a fence the model wrapped it in', async () => {
    const h = await openBlocks([{ type: 'codeBlock', props: { language: 'python' }, content: 'a = 1\nb = 2\nc = 3' }]);
    replaceWith(h, rangeOf(h, 'b = 2'), () => '```python\nb = 20\n```');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', 'a = 1\nb = 20\nc = 3']]);
  });
});

describe('edits while the dialog is open (A6, A7)', () => {
  it('replaces the range after Enter and typing inside it', async () => {
    const h = await open('Before.\n\nOne two.\n\nThree four.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One').from, to: rangeOf(h, 'four.').to });
    // Enter splits the line and its block, as BlockNote does.
    h.editor.prosemirrorView!.dispatch(h.editor.prosemirrorState.tr.split(rangeOf(h, 'two').from, 2));
    type(h, rangeOf(h, 'Three').from, 'typed ');
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Before.', 'New.', 'After.']);
  });

  it('joins the words on both lines when Enter split the range of words', async () => {
    const h = await open('Intro: x y z end.');
    capture(h, rangeOf(h, 'x y z'));
    h.editor.prosemirrorView!.dispatch(h.editor.prosemirrorState.tr.split(rangeOf(h, 'y z').from, 2));
    expect(painted(h).join('')).toBe('x y z');
    replaceAiAnswer(h, read(h, 'X Y Z'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Intro: X Y Z end.']);
  });

  it('replaces both halves of a last block Enter split', async () => {
    const h = await open('Before.\n\nOne two.\n\nThree four.\n\nAfter.');
    capture(h, { from: rangeOf(h, 'One').from, to: rangeOf(h, 'four.').to });
    h.editor.prosemirrorView!.dispatch(h.editor.prosemirrorState.tr.split(rangeOf(h, 'four.').from, 2));
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Before.', 'New.', 'After.']);
  });

  it('keeps the words Backspace merged into the last block outside the range, painted and written', async () => {
    const h = await open('Before.\n\nOne two.\n\nThree four.\n\nAfter.\n\nTail.');
    capture(h, { from: rangeOf(h, 'One').from, to: rangeOf(h, 'four.').to });
    const view = h.editor.prosemirrorView!;
    view.dispatch(view.state.tr.join(rangeOf(h, 'After.').from - 2, 2));
    expect(painted(h).join('')).not.toContain('After.');
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Before.', 'New.After.', 'Tail.']);
  });

  it('replaces a table inside the range whole once the first block is gone', async () => {
    const h = await open('Pone\n\n| a | b |\n| --- | --- |\n| c | d |\n\nPtwo\n\nAfter');
    capture(h, { from: rangeOf(h, 'Pone').from, to: rangeOf(h, 'Ptwo').to });
    h.editor.removeBlocks([blocks(h)[0]!.id]);
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'New.'], ['paragraph', 'After']]);
  });

  it('replaces a table whole, never cut, once both ends of the range are gone', async () => {
    const h = await open('Pone\n\n| a | b |\n| --- | --- |\n| c | d |\n\nPtwo\n\nAfter');
    capture(h, { from: rangeOf(h, 'Pone').from, to: rangeOf(h, 'Ptwo').to });
    h.editor.removeBlocks([blocks(h)[0]!.id, blocks(h)[2]!.id]);
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'New.'], ['paragraph', 'After']]);
  });

  it('paints the whole table once the last block is moved into a cell, and replaces what it paints', async () => {
    const h = await open('First.\n\nLast.\n\n| keep1 | keep2 |\n| --- | --- |\n| keep3 | keep4 |\n\nAfter.');
    capture(h, { from: rangeOf(h, 'First.').from, to: rangeOf(h, 'Last.').to });
    const view = h.editor.prosemirrorView!;
    const at = rangeOf(h, 'Last.').from - 2;
    const node = view.state.doc.nodeAt(at)!;
    const tr = view.state.tr.insert(rangeOf(h, 'keep3').to + 1, node);
    tr.delete(at, at + node.nodeSize);
    view.dispatch(tr);
    expect(painted(h).join('')).toContain('keep4');
    replaceAiAnswer(h, read(h, 'New.'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['New.', 'After.']);
  });

  it('overwrites an empty line a Shift+Down selection runs over', async () => {
    const h = await openBlocks([{ type: 'paragraph', content: 'Before.' }, { type: 'paragraph', content: 'One.' }, { type: 'paragraph', content: 'Two.' }, { type: 'paragraph' }, { type: 'paragraph', content: 'After.' }]);
    capture(h, { from: rangeOf(h, 'One.').from, to: rangeOf(h, 'After.').from });
    replaceAiAnswer(h, read(h, 'Z.'), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Before.', 'Z.', 'After.']);
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

  it('inserts a table answered in a docTable cell as the preview shows it once the range is gone', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c dd | e |');
    capture(h, rangeOf(h, 'dd'));
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'dd');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    const answer = read(h, '| x | y |\n| --- | --- |\n| z | w |');
    expect(insertAiAnswer(h, insertBlock(h)!, answer, WRITABLE).outcome).toBe('written');
    const cell = blocks(h)[0]!.children[1]!.children[0]!;
    expect(cell.children.slice(1).map(idless)).toEqual(answer.preview.map(idless));
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
    expect(replaceAiAnswer(h, answer, admission)).toEqual({ outcome });
    expect(insertAiAnswer(h, blocks(h)[0]!.id, answer, admission)).toEqual({ outcome });
    expect(blocks(h).map(textOf)).toEqual(['One.']);
  });
});
