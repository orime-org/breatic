// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI dialog's text units (inner#1860 A6, design §4.6, §5.1–§5.3, §8):
 * what is sent, how the answer is read back, what the preview shows and
 * what replace and insert write, all from one computation per unit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { aiRangeIn, DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import {
  aiAnswer,
  aiReplaceAvailable,
  aiTextUnits,
  aiUnitsRequest,
  insertAiAnswer,
  replaceAiAnswer,
  unitSpan,
  type AiAnswer,
  type AiTextUnit,
} from '@web/spaces/document/document-ai-units';
import type { AiCommand } from '@web/spaces/document/document-ai-session';
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

type Command = AiCommand['id'];

/** A block as the editor reads it, loosely typed for assertions. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: Seen[];
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
    readWho: () => ({ role: 'editor', viewerId: 'reader-1' }),
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
 * The body's blocks.
 * @param handle - The document.
 * @returns Them.
 */
function blocks(handle: DocumentEditorHandle): Seen[] {
  return handle.editor.document as unknown as Seen[];
}

/**
 * A block's words, a hard break read as a newline.
 * @param block - The block.
 * @returns Its words.
 */
function textOf(block: Seen): string {
  if (!Array.isArray(block.content)) return '';
  return (block.content as Array<{ type: string; text?: string; content?: Array<{ text: string }> }>)
    .map((c) => (c.type === 'link' ? (c.content ?? []).map((t) => t.text).join('') : c.text ?? ''))
    .join('');
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
 * Opens the original range over some stretch, as the dialog does.
 * @param handle - The document.
 * @param range - The stretch.
 */
function hold(handle: DocumentEditorHandle, range: LocalRange): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [range]));
}

/**
 * The original range now.
 * @param handle - The document.
 * @returns Its segments; none once gone.
 */
function segments(handle: DocumentEditorHandle): readonly LocalRange[] {
  const range = aiRangeIn(handle.editor.prosemirrorState);
  return range?.kind === 'present' ? range.segments : [];
}

/** One opening: its units and what it sends. */
interface Opening {
  units: AiTextUnit[];
  request: string;
}

/**
 * Opens the dialog over a stretch and builds the request.
 * @param handle - The document.
 * @param range - The stretch.
 * @param command - The command.
 * @returns The units and the request.
 */
function opening(handle: DocumentEditorHandle, range: LocalRange, command: Command): Opening {
  hold(handle, range);
  const doc = handle.editor.prosemirrorState.doc;
  const units = aiTextUnits(doc, segments(handle));
  return { units, request: aiUnitsRequest(handle.editor, doc, units, segments(handle), command) };
}

/**
 * A model that answers every unit with exactly what it was sent.
 * @param request - What was sent.
 * @returns The answer.
 */
function echo(request: string): string {
  return request.replace(/<u id="(\d+)"[^>]*>/g, '<u id="$1">');
}

/**
 * The units' bodies as sent, by id.
 * @param request - What was sent.
 * @returns Each unit's text.
 */
function sent(request: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of request.matchAll(/<u id="(\d+)"[^>]*>([\s\S]*?)<\/u>/g)) out.set(Number(m[1]), m[2]!);
  return out;
}

/**
 * An answer from its units.
 * @param parts - Each unit's text, by id.
 * @returns The tagged answer.
 */
function tagged(parts: Record<number, string>): string {
  return Object.entries(parts).map(([id, text]) => `<u id="${id}">${text}</u>`).join('\n');
}

/**
 * Reads an answer the way the dialog does.
 * @param handle - The document.
 * @param o - The opening.
 * @param text - The answer.
 * @param command - The command.
 * @returns The answer.
 */
function read(handle: DocumentEditorHandle, o: Opening, text: string, command: Command): AiAnswer {
  return aiAnswer(handle.editor, handle.editor.prosemirrorState.doc, o.units, text, command, OURS);
}

/**
 * Runs a command over a stretch to a replace.
 * @param handle - The document.
 * @param range - The stretch.
 * @param command - The command.
 * @param answerFor - The model.
 * @returns The answer that was written.
 */
function replaceWith(
  handle: DocumentEditorHandle,
  range: LocalRange,
  command: Command,
  answerFor: (o: Opening) => string,
): AiAnswer {
  const o = opening(handle, range, command);
  const answer = read(handle, o, answerFor(o), command);
  expect(replaceAiAnswer(handle, answer, segments(handle), WRITABLE).outcome).toBe('written');
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
 * Sets a block's props after opening, the way the toolbar would.
 * @param handle - The document.
 * @param words - Words in the block.
 * @param props - The props.
 */
function style(handle: DocumentEditorHandle, words: string, props: Record<string, unknown>): void {
  const block = flat(handle).find((b) => textOf(b).includes(words))!;
  handle.editor.updateBlock(block.id, { props } as never);
  handle.undoManager.clear();
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
  const rows = (table.content as { rows: Array<{ cells: Array<{ content: Array<{ type: string; text?: string }> }> }> }).rows;
  return rows.map((row) => row.cells.map((cell) => cell.content.map((c) => (c.type === 'text' ? c.text : '\n')).join('')));
}

describe('the units of a range', () => {
  it('makes one unit per block with selected words, in order, telling whole blocks from partial ones', async () => {
    const h = await open('## Title words\n\nA body line.\n\n- one item');
    const units = opening(h, { from: rangeOf(h, 'words').from, to: rangeOf(h, 'one').to }, 'refine').units;
    expect(units.map((u) => [u.id, u.kind, u.whole])).toEqual([[1, 'heading', false], [2, 'paragraph', true], [3, 'bulletListItem', false]]);
  });

  it('leaves images, videos and empty lines out of the units', async () => {
    const h = await open(`first\n\n![a](${OURS}a.png)\n\n\n\nsecond`);
    const o = opening(h, { from: rangeOf(h, 'first').from, to: rangeOf(h, 'second').to }, 'refine');
    expect(o.units.map((u) => u.kind)).toEqual(['paragraph', 'paragraph']);
    expect([...sent(o.request).values()]).toEqual(['first', 'second']);
  });

  it('makes each nested child block its own unit', async () => {
    const h = await open('- parent\n    - child');
    expect(opening(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'child').to }, 'refine').units).toHaveLength(2);
  });

  it('finds a docTable cell block by its own id and a legacy cell by the table and its place', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | d |');
    legacyTable(h, [['x', 'y']]);
    const legacy = opening(h, { from: rangeOf(h, 'x').from, to: rangeOf(h, 'y').to }, 'refine').units;
    expect(legacy.map((u) => [u.kind, u.blockId, u.cell])).toEqual([['tableCell', 'legacy-table', { row: 0, col: 0 }], ['tableCell', 'legacy-table', { row: 0, col: 1 }]]);
    const modern = opening(h, { from: rangeOf(h, 'c').from, to: rangeOf(h, 'd').to }, 'refine').units;
    expect(modern.map((u) => u.kind)).toEqual(['paragraph', 'paragraph']);
    expect(new Set(modern.map((u) => u.blockId)).size).toBe(2);
  });

  it('has no span once its selected words are deleted, and keeps the others', async () => {
    const h = await open('one\n\ntwo');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine');
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'one');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    const doc = h.editor.prosemirrorState.doc;
    expect(unitSpan(doc, o.units[0]!, segments(h))).toBeNull();
    expect(unitSpan(doc, o.units[1]!, segments(h))).toEqual(rangeOf(h, 'two'));
  });
});

describe('the request', () => {
  it('tags every unit with its number and kind', async () => {
    const h = await open('## Head\n\nBody');
    const o = opening(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'Body').to }, 'refine');
    expect(o.request).toBe('<u id="1" kind="heading">Head</u>\n<u id="2" kind="paragraph">Body</u>');
  });

  it('sends whole blocks of a custom command with the markers BlockNote writes, and partial ones as words', async () => {
    const h = await open('## Head\n\n- [ ] todo\n\nsome words here');
    const o = opening(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'words').to }, 'custom');
    expect([...sent(o.request).values()]).toEqual(['## Head', '* [ ] todo', 'some words']);
  });

  it('sends a whole code block of a custom command fenced with its language', async () => {
    const h = await open('```python\nx = 1 < 2\n```');
    const o = opening(h, rangeOf(h, 'x = 1 < 2'), 'custom');
    expect([...sent(o.request).values()]).toEqual(['```python\nx = 1 &lt; 2\n```']);
  });

  it('sends a code block of a fixed command as its text, only & < > escaped', async () => {
    const h = await open('```python\ndef f(*args): return a & b < c\n```');
    const o = opening(h, rangeOf(h, 'def f(*args): return a & b < c'), 'refine');
    expect([...sent(o.request).values()]).toEqual(['def f(*args): return a &amp; b &lt; c']);
  });

  it('measures the budget on the tagged string, which is longer than the words', async () => {
    const h = await open('one\n\ntwo');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine');
    expect(o.request.length).toBeGreaterThan('one\n\ntwo'.length);
  });
});

describe('reading an answer', () => {
  it('shows only answered units, ignores ids never sent and a tag still being written', async () => {
    const h = await open('one\n\ntwo\n\nthree');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'three').to }, 'refine');
    const answer = read(h, o, '<u id="1">ONE</u><u id="9">nine</u><u id="3">THR', 'refine');
    expect(answer.results.map((r) => r.unit.id)).toEqual([1]);
    expect(answer.preview.map((b) => textOf(b as Seen))).toEqual(['ONE']);
    expect(answer.formatFailed).toBe(false);
  });

  it('takes a whole untagged answer as the one unit sent', async () => {
    const h = await open('one');
    const o = opening(h, rangeOf(h, 'one'), 'refine');
    const answer = read(h, o, 'ONE', 'refine');
    expect(answer.formatFailed).toBe(false);
    expect(answer.preview.map((b) => textOf(b as Seen))).toEqual(['ONE']);
  });

  it('fails the format when tags came and no unit sent is recognised, one unit sent or many', async () => {
    const h = await open('one\n\ntwo');
    const single = opening(h, rangeOf(h, 'one'), 'refine');
    expect(read(h, single, '<u id="7">x</u>', 'refine').formatFailed).toBe(true);
    const many = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine');
    expect(read(h, many, '<u id="7">x</u>', 'refine').formatFailed).toBe(true);
  });

  it('fails the format when several units were sent and the answer has no tags', async () => {
    const h = await open('one\n\ntwo');
    const many = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine');
    expect(read(h, many, 'ONE TWO', 'refine').formatFailed).toBe(true);
  });

  it('treats an empty unit of a fixed command as unanswered', async () => {
    const h = await open('## Head\n\nBody');
    const o = opening(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'Body').to }, 'translate');
    const answer = read(h, o, tagged({ 1: '', 2: 'Corps' }), 'translate');
    expect(answer.results.map((r) => r.unit.id)).toEqual([2]);
  });

  it.each([
    ['1. step', '1. step'],
    ['1) Erster Schritt', '1) Erster Schritt'],
    ['# not a heading', '# not a heading'],
    ['> not a quote', '> not a quote'],
    ['- not a list', '- not a list'],
    ['  - indented', '- indented'],
    ['---', '---'],
    ['___', '___'],
    ['| a | b |', '| a | b |'],
    ['```', '```'],
    ['line\n===', 'line\n==='],
    ['Steps:\n1. open it', 'Steps:\n1. open it'],
    ['use <b> tag', 'use <b> tag'],
    ['x <div>y</div> z', 'x <div>y</div> z'],
  ])('keeps a fixed command answer %j as words in one block', async (answerText, words) => {
    const h = await open('## Head');
    const o = opening(h, rangeOf(h, 'Head'), 'refine');
    const answer = read(h, o, tagged({ 1: answerText }), 'refine');
    expect(answer.preview).toHaveLength(1);
    expect((answer.preview[0] as Seen).type).toBe('heading');
    expect(textOf(answer.preview[0] as Seen)).toBe(words);
  });

  it('keeps bold and italic at the start of a line of a fixed command answer', async () => {
    const h = await open('Body');
    const o = opening(h, rangeOf(h, 'Body'), 'refine');
    const answer = read(h, o, tagged({ 1: '**Note**: *keep* it' }), 'refine');
    expect((answer.preview[0] as Seen).content).toEqual([
      { type: 'text', text: 'Note', styles: { bold: true } },
      { type: 'text', text: ': ', styles: {} },
      { type: 'text', text: 'keep', styles: { italic: true } },
      { type: 'text', text: ' it', styles: {} },
    ]);
  });

  it('leaves outside images out of a custom answer and counts them', async () => {
    const h = await open('Body');
    const o = opening(h, rangeOf(h, 'Body'), 'custom');
    const answer = read(h, o, tagged({ 1: 'Text\n\n![x](https://elsewhere.example/x.png)' }), 'custom');
    expect(answer.leftOut).toBe(1);
    expect(answer.preview.map((b) => (b as Seen).type)).toEqual(['paragraph']);
  });
});

describe('the escape pair', () => {
  it.each([
    ['2. a *b* <b> R&D x > 3 [l](u) \\ back'],
    ['C:\\dir\\x and \\* already'],
    ['lit &amp; and &lt;b&gt; text'],
  ])('writes %j back word for word when the model echoes it', async (words) => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: words }] as never);
    const before = structuredClone(blocks(h));
    for (const command of ['refine', 'custom'] as const) {
      replaceWith(h, rangeOf(h, words), command, (o) => echo(o.request));
      expect(blocks(h)).toEqual(before);
    }
  });

  it('writes inline code, links with brackets and hard breaks back unchanged when echoed', async () => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'call ', styles: {} },
        { type: 'text', text: '__init__ `x` *args', styles: { code: true } },
        { type: 'text', text: ' see ', styles: {} },
        { type: 'link', href: 'https://en.wikipedia.org/wiki/Foo_(bar)?a=1&b=2', content: [{ type: 'text', text: 'w_x', styles: {} }] },
        { type: 'text', text: '\nline two', styles: {} },
      ],
    }] as never);
    const before = structuredClone(blocks(h));
    const doc = h.editor.prosemirrorState.doc;
    replaceWith(h, { from: 1, to: doc.content.size - 1 }, 'refine', (o) => echo(o.request));
    expect(blocks(h)).toEqual(before);
  });
});

describe('replace with a fixed command', () => {
  it('keeps the kind, level and props of whole blocks, and list items in their list', async () => {
    const h = await open('## Head\n\n- [x] done item\n\n- one\n- two');
    style(h, 'Head', { textColor: 'red' });
    replaceWith(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'one').to }, 'refine', () => tagged({ 1: 'New head', 2: 'Done thing', 3: 'First' }));
    expect(blocks(h).map((b) => [b.type, b.props['level'] ?? b.props['checked'] ?? null, textOf(b)])).toEqual([
      ['heading', 2, 'New head'], ['checkListItem', true, 'Done thing'], ['bulletListItem', null, 'First'], ['bulletListItem', null, 'two'],
    ]);
    expect(blocks(h)[0]!.props['textColor']).toBe('red');
  });

  it('changes only the selected words of a heading selected in part', async () => {
    const h = await open('## Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), 'refine', () => tagged({ 1: 'X' }));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['heading', 'Intro: X end.']]);
  });

  it('leaves images, empty lines and empty blocks with children in the selection where they are, once', async () => {
    const h = await open(`first\n\n![a](${OURS}a.png)\n\n\n\nsecond`);
    const before = blocks(h).map((b) => [b.id, b.type]);
    replaceWith(h, { from: rangeOf(h, 'first').from, to: rangeOf(h, 'second').to }, 'refine', () => tagged({ 1: 'FIRST', 2: 'SECOND' }));
    expect(blocks(h).map((b) => [b.id, b.type])).toEqual(before);
    expect(blocks(h).map(textOf)).toEqual(['FIRST', '', '', 'SECOND']);
  });

  it('writes a translated "2. Methoden" with its number', async () => {
    const h = await open('## 2\\. Methods');
    replaceWith(h, rangeOf(h, '2. Methods'), 'translate', () => tagged({ 1: '2. Methoden' }));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['heading', '2. Methoden']]);
  });

  it('writes a code block answer word for word', async () => {
    const h = await open('```python\ndef f(*args): return __init__\n```');
    replaceWith(h, rangeOf(h, 'def f(*args): return __init__'), 'refine', () => tagged({ 1: 'def g(*args): return __init__' }));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', 'def g(*args): return __init__']]);
  });

  it('writes nested child units each with its own answer', async () => {
    const h = await open('- parent\n    - child');
    replaceWith(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'child').to }, 'refine', () => tagged({ 1: 'PARENT', 2: 'CHILD' }));
    expect(flat(h).map(textOf)).toEqual(['PARENT', 'CHILD']);
  });

  it('keeps a translated heading the model answered empty', async () => {
    const h = await open('## Head\n\nBody');
    replaceWith(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'Body').to }, 'translate', () => tagged({ 1: '', 2: 'Corps' }));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['heading', 'Head'], ['paragraph', 'Corps']]);
  });

  it('leaves a unit the answer skipped as it was', async () => {
    const h = await open('one\n\ntwo');
    replaceWith(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine', () => tagged({ 2: 'TWO' }));
    expect(blocks(h).map(textOf)).toEqual(['one', 'TWO']);
  });

  it('replaces in each cell of both kinds of table, rows and columns unchanged', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | d |');
    legacyTable(h, [['x', 'y']]);
    replaceWith(h, { from: rangeOf(h, 'x').from, to: rangeOf(h, 'y').to }, 'refine', () => tagged({ 1: 'X', 2: 'Y' }));
    expect(legacyCells(h)).toEqual([['X', 'Y']]);
    replaceWith(h, { from: rangeOf(h, 'c').from, to: rangeOf(h, 'd').to }, 'refine', () => tagged({ 1: 'C', 2: 'D' }));
    const table = blocks(h).find((b) => b.type === 'docTable')!;
    expect(table.children.map((row) => row.children.map((cell) => cell.children.map(textOf)))).toEqual([[['a'], ['b']], [['C'], ['D']]]);
  });

  it('is one undo step for every unit', async () => {
    const h = await open('one\n\ntwo');
    replaceWith(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine', () => tagged({ 1: 'ONE', 2: 'TWO' }));
    h.editor.undo();
    expect(blocks(h).map(textOf)).toEqual(['one', 'two']);
  });
});

describe('replace with expand', () => {
  it('splits a paragraph into paragraphs carrying its quote, colour and alignment, a "1." line kept as words', async () => {
    const h = await open('Body');
    style(h, 'Body', { quoted: true, textColor: 'red', textAlignment: 'center' });
    replaceWith(h, rangeOf(h, 'Body'), 'expand', () => tagged({ 1: 'First part.\n\n1. still words' }));
    expect(blocks(h).map((b) => [b.type, textOf(b), b.props['quoted'], b.props['textColor'], b.props['textAlignment']])).toEqual([
      ['paragraph', 'First part.', true, 'red', 'center'],
      ['paragraph', '1. still words', true, 'red', 'center'],
    ]);
  });

  it('makes a heading longer without splitting it', async () => {
    const h = await open('## Head');
    replaceWith(h, rangeOf(h, 'Head'), 'expand', () => tagged({ 1: 'A longer head\n\nwith more' }));
    expect(blocks(h).map((b) => b.type)).toEqual(['heading']);
  });
});

describe('replace with custom', () => {
  it('turns a whole paragraph into a list', async () => {
    const h = await open('a b c');
    replaceWith(h, rangeOf(h, 'a b c'), 'custom', () => tagged({ 1: '- a\n- b\n- c' }));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['bulletListItem', 'a'], ['bulletListItem', 'b'], ['bulletListItem', 'c']]);
  });

  it('splits a paragraph selected in part around the list, words left out kept', async () => {
    const h = await open('Intro: x y z end.');
    replaceWith(h, rangeOf(h, 'x y z'), 'custom', () => tagged({ 1: '- x\n- y\n- z' }));
    expect(blocks(h).map((b) => [b.type, textOf(b).trim()])).toEqual([
      ['paragraph', 'Intro:'], ['bulletListItem', 'x'], ['bulletListItem', 'y'], ['bulletListItem', 'z'], ['paragraph', 'end.'],
    ]);
  });

  it('keeps quote and colours on every piece of a quoted coloured paragraph turned into a list in part', async () => {
    const h = await open('Intro: x y end.');
    style(h, 'Intro', { quoted: true, textColor: 'red', backgroundColor: 'blue' });
    replaceWith(h, rangeOf(h, 'x y'), 'custom', () => tagged({ 1: '- x\n- y' }));
    expect(blocks(h).map((b) => [b.props['quoted'], b.props['textColor'], b.props['backgroundColor']])).toEqual(
      Array.from({ length: 4 }, () => [true, 'red', 'blue']),
    );
  });

  it('keeps the level of a heading split in part', async () => {
    const h = await open('## Intro: x y end.');
    replaceWith(h, rangeOf(h, 'x y'), 'custom', () => tagged({ 1: '- x\n- y' }));
    expect(blocks(h).map((b) => [b.type, b.props['level'] ?? null])).toEqual([['heading', 2], ['bulletListItem', null], ['bulletListItem', null], ['heading', 2]]);
  });

  it('hangs the children under the piece after the words when the words sit in the middle', async () => {
    const h = await open('- Intro: x y end.\n    - child');
    const child = flat(h).find((b) => textOf(b) === 'child')!.id;
    replaceWith(h, rangeOf(h, 'x y'), 'custom', () => tagged({ 1: '1. x\n2. y' }));
    const top = blocks(h);
    expect(top.map((b) => textOf(b).trim())).toEqual(['Intro:', 'x', 'y', 'end.']);
    expect(top[3]!.children.map((c) => c.id)).toEqual([child]);
  });

  it('hangs the children under the last answer block when the words run to the end', async () => {
    const h = await open('- Intro: x y\n    - child');
    const child = flat(h).find((b) => textOf(b) === 'child')!.id;
    replaceWith(h, rangeOf(h, 'x y'), 'custom', () => tagged({ 1: '1. x\n2. y' }));
    const top = blocks(h);
    expect(top.map((b) => textOf(b).trim())).toEqual(['Intro:', 'x', 'y']);
    expect(top[2]!.children.map((c) => c.id)).toEqual([child]);
  });

  it('leaves no empty block and no repeated id when the words start the block', async () => {
    const h = await open('- x y end.\n    - child');
    replaceWith(h, rangeOf(h, 'x y'), 'custom', () => tagged({ 1: '1. x\n2. y' }));
    const all = flat(h);
    expect(all.filter((b) => textOf(b) === '')).toEqual([]);
    expect(new Set(all.map((b) => b.id)).size).toBe(all.length);
    expect(all.map((b) => textOf(b).trim())).toEqual(['x', 'y', 'end.', 'child']);
  });

  it('turns the whole block into the answer when every word is selected, children kept once', async () => {
    const h = await open('- all words\n    - child');
    replaceWith(h, rangeOf(h, 'all words'), 'custom', () => tagged({ 1: '1. a\n2. b' }));
    const all = flat(h);
    expect(all.map((b) => [b.type, textOf(b)])).toEqual([['numberedListItem', 'a'], ['numberedListItem', 'b'], ['bulletListItem', 'child']]);
    expect(new Set(all.map((b) => b.id)).size).toBe(all.length);
  });

  it('changes kinds per unit as answered', async () => {
    const h = await open('one\n\ntwo');
    replaceWith(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'custom', () => tagged({ 1: '- one', 2: '## two' }));
    expect(blocks(h).map((b) => [b.type, b.props['level'] ?? null])).toEqual([['bulletListItem', null], ['heading', 2]]);
  });

  it('keeps level and colour when only the wording of a heading changes', async () => {
    const h = await open('## Head');
    style(h, 'Head', { textColor: 'red' });
    replaceWith(h, rangeOf(h, 'Head'), 'custom', () => tagged({ 1: '## New head' }));
    expect(blocks(h).map((b) => [b.type, b.props['level'], b.props['textColor'], textOf(b)])).toEqual([['heading', 2, 'red', 'New head']]);
  });

  it('keeps a to-do and its tick when only its wording changes', async () => {
    const h = await open('- [x] buy milk');
    replaceWith(h, rangeOf(h, 'buy milk'), 'custom', () => tagged({ 1: '* [x] buy oat milk' }));
    expect(blocks(h).map((b) => [b.type, b.props['checked'], textOf(b)])).toEqual([['checkListItem', true, 'buy oat milk']]);
  });

  it('turns a whole code block into an explanation paragraph', async () => {
    const h = await open('```python\nx = 1\n```');
    replaceWith(h, rangeOf(h, 'x = 1'), 'custom', () => tagged({ 1: 'This sets x to one.' }));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'This sets x to one.']]);
  });

  it('keeps a code block a code block of its language when only the code changes', async () => {
    const h = await open('```python\nx = 1\n```');
    replaceWith(h, rangeOf(h, 'x = 1'), 'custom', () => tagged({ 1: '```python\nx = 2  # *two*\n```' }));
    expect(blocks(h).map((b) => [b.type, b.props['language'], textOf(b)])).toEqual([['codeBlock', 'python', 'x = 2  # *two*']]);
  });

  it('merges: clears the units left empty, drops a block that becomes empty', async () => {
    const h = await open('one\n\ntwo\n\nthree');
    replaceWith(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'three').to }, 'custom', () => tagged({ 1: 'one two three', 2: '', 3: '' }));
    expect(blocks(h).map(textOf)).toEqual(['one two three']);
  });

  it('writes a list answered for a legacy table cell as its words on lines, and keeps an emptied cell', async () => {
    const h = await open('');
    legacyTable(h, [['x', 'y']]);
    replaceWith(h, { from: rangeOf(h, 'x').from, to: rangeOf(h, 'y').to }, 'custom', () => tagged({ 1: '- a\n- b', 2: '' }));
    expect(legacyCells(h)).toEqual([['a\nb', '']]);
  });

  it('unfolds a table answered for a docTable cell, the outer table unchanged', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | d |');
    replaceWith(h, rangeOf(h, 'c'), 'custom', () => tagged({ 1: '| p | q |\n| --- | --- |\n| r | s |' }));
    const tables = flat(h).filter((b) => b.type === 'docTable');
    expect(tables).toHaveLength(1);
    expect(tables[0]!.children.map((row) => row.children.length)).toEqual([2, 2]);
  });
});

describe('the preview is what is written', () => {
  it('writes for each whole unit exactly the blocks the preview shows', async () => {
    const h = await open('## Head\n\nPara\n\n- item');
    const o = opening(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'item').to }, 'custom');
    const answer = read(h, o, tagged({ 1: '## New head', 2: '- a\n- b', 3: 'Plain now' }), 'custom');
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(blocks(h).map(idless)).toEqual(answer.preview.map(idless));
  });

  it('writes the answer blocks the preview shows between the words left out', async () => {
    const h = await open('Intro: x y end.');
    const o = opening(h, rangeOf(h, 'x y'), 'custom');
    const answer = read(h, o, tagged({ 1: '- x\n- y' }), 'custom');
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(blocks(h).slice(1, 3).map(idless)).toEqual(answer.preview.map(idless));
  });
});

describe('when replace is available', () => {
  it('is off when a merge target lost its words while the others still have theirs', async () => {
    const h = await open('one\n\ntwo');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'custom');
    const answer = read(h, o, tagged({ 1: 'one two', 2: '' }), 'custom');
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'one');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(false);
  });

  it('is off when no answered unit still has words, and on while every answered one does', async () => {
    const h = await open('one\n\ntwo');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine');
    const answer = read(h, o, tagged({ 1: 'ONE' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'one');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(false);
  });
});

describe('insert', () => {
  it('puts the preview blocks under the insert block, the body before it unchanged', async () => {
    const h = await open('one\n\ntwo\n\nafter');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'custom');
    const answer = read(h, o, tagged({ 1: '- a', 2: 'b' }), 'custom');
    const insertAt = blocks(h)[1]!.id;
    expect(insertAiAnswer(h, insertAt, answer, WRITABLE).outcome).toBe('written');
    expect(blocks(h).map(textOf)).toEqual(['one', 'two', 'a', 'b', 'after']);
    expect(blocks(h).slice(2, 4).map(idless)).toEqual(answer.preview.map(idless));
  });

  it('copies a legacy table the selection runs into as a docTable', async () => {
    const h = await open('');
    legacyTable(h, [['x', 'y']]);
    const o = opening(h, { from: rangeOf(h, 'x').from, to: rangeOf(h, 'y').to }, 'refine');
    const answer = read(h, o, tagged({ 1: 'X', 2: 'Y' }), 'refine');
    expect(answer.preview.map((b) => (b as Seen).type)).toEqual(['docTable']);
    insertAiAnswer(h, 'legacy-table', answer, WRITABLE);
    expect(blocks(h).map((b) => b.type).slice(0, 2)).toEqual(['table', 'docTable']);
  });
});

/** Words a model may send back, block syntax and escapes included. */
const tricky = fc.stringMatching(/^[a-z *_`#>\-+.1)([\]\\&<|=~!]{1,24}$/);

/** A block of a body: one with words, an image or an empty line. */
type Seed = 'image' | 'empty' | { type: string; text: string; bold: boolean };

/** A block with words, of a kind the body holds. */
const wordy = fc.record({
  type: fc.constantFrom('paragraph', 'heading', 'bulletListItem', 'checkListItem', 'numberedListItem'),
  text: tricky.filter((t) => t.trim() !== ''),
  bold: fc.boolean(),
});

/** A body: blocks with words, images and empty lines mixed. */
const body: fc.Arbitrary<Seed[]> = fc.array(
  fc.oneof({ weight: 4, arbitrary: wordy }, { weight: 1, arbitrary: fc.constantFrom<'image' | 'empty'>('image', 'empty') }),
  { minLength: 1, maxLength: 6 },
);

/**
 * Builds a body.
 * @param handle - The document.
 * @param seeds - What it holds.
 */
function build(handle: DocumentEditorHandle, seeds: readonly Seed[]): void {
  handle.editor.replaceBlocks(handle.editor.document, seeds.map((seed) => {
    if (seed === 'image') return { type: 'image', props: { url: `${OURS}x.png` } };
    if (seed === 'empty') return { type: 'paragraph' };
    return { type: seed.type, content: [{ type: 'text', text: seed.text, styles: seed.bold ? { bold: true } : {} }] };
  }) as never);
  handle.undoManager.clear();
}

/**
 * Holds a stretch picked from two numbers.
 * @param handle - The document.
 * @param a - One end, any number.
 * @param b - The other.
 * @returns Whether it holds any word.
 */
function holdSome(handle: DocumentEditorHandle, a: number, b: number): LocalRange | null {
  const size = handle.editor.prosemirrorState.doc.content.size;
  const [from, to] = [1 + (a % (size - 1)), 1 + (b % (size - 1))].sort((x, y) => x - y) as [number, number];
  if (from === to) return null;
  hold(handle, { from, to });
  return segments(handle).length === 0 ? null : { from, to };
}

/**
 * The words of a unit's block before and after its span.
 * @param handle - The document.
 * @param unit - The unit.
 * @returns Them.
 */
function around(handle: DocumentEditorHandle, unit: AiTextUnit): { before: string; after: string } {
  const doc = handle.editor.prosemirrorState.doc;
  const span = unitSpan(doc, unit, segments(handle))!;
  const $span = doc.resolve(span.from);
  const start = $span.start();
  const end = $span.end();
  return { before: doc.textBetween(start, span.from), after: doc.textBetween(span.to, end) };
}

describe('properties', () => {
  it('writes any body back unchanged when the model echoes every unit, for every command', async () => {
    const h = await open('');
    await fc.assert(fc.asyncProperty(body, fc.nat(), fc.nat(), fc.constantFrom<Command>('refine', 'custom'), async (seeds, a, b, command) => {
      build(h, seeds);
      const range = holdSome(h, a, b);
      if (range === null) return;
      const before = structuredClone(blocks(h));
      const o = opening(h, range, command);
      replaceAiAnswer(h, read(h, o, echo(o.request), command), segments(h), WRITABLE);
      expect(blocks(h)).toEqual(before);
    }), { numRuns: 40 });
  });

  it('for any fixed answer keeps blocks without words once and in order, every kind and prop, the words outside the spans, and writes what the preview shows', async () => {
    const h = await open('');
    await fc.assert(fc.asyncProperty(body, fc.nat(), fc.nat(), fc.array(tricky, { minLength: 6, maxLength: 6 }), async (seeds, a, b, answers) => {
      build(h, seeds);
      const range = holdSome(h, a, b);
      if (range === null) return;
      const kinds = blocks(h).map((x) => [x.id, x.type, x.props]);
      const wordless = blocks(h).filter((x) => textOf(x) === '').map((x) => x.id);
      const o = opening(h, range, 'refine');
      const outside = o.units.map((u) => around(h, u));
      const parts = Object.fromEntries(o.units.map((u, i) => [u.id, answers[i]!]));
      const answer = read(h, o, tagged(parts), 'refine');
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect(blocks(h).map((x) => [x.id, x.type, x.props])).toEqual(kinds);
      expect(blocks(h).filter((x) => wordless.includes(x.id)).map((x) => x.id)).toEqual(wordless);
      o.units.forEach((u, i) => {
        const now = textOf(blocks(h).find((x) => x.id === u.blockId)!);
        expect(now.startsWith(outside[i]!.before) && now.endsWith(outside[i]!.after)).toBe(true);
      });
      answer.results.filter((r) => r.unit.whole && r.write.kind === 'inline').forEach((r) => {
        const written = blocks(h).find((x) => x.id === r.unit.blockId)!;
        expect(idless(written)).toEqual(idless(r.write.kind === 'inline' ? r.write.block : null));
      });
    }), { numRuns: 40 });
  });

  it('never changes the body before the insert block', async () => {
    const h = await open('');
    await fc.assert(fc.asyncProperty(body, fc.nat(), fc.nat(), fc.array(tricky, { minLength: 6, maxLength: 6 }), async (seeds, a, b, answers) => {
      build(h, seeds);
      const range = holdSome(h, a, b);
      if (range === null) return;
      const o = opening(h, range, 'custom');
      const parts = Object.fromEntries(o.units.map((u, i) => [u.id, answers[i]!]));
      const answer = read(h, o, tagged(parts), 'custom');
      const at = o.units[o.units.length - 1]!.blockId;
      const index = blocks(h).findIndex((x) => x.id === at);
      const before = structuredClone(blocks(h).slice(0, index + 1));
      insertAiAnswer(h, at, answer, WRITABLE);
      expect(blocks(h).slice(0, index + 1)).toEqual(before);
    }), { numRuns: 30 });
  });
});
