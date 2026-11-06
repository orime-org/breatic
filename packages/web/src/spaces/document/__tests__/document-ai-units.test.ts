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
import { TextSelection } from '@tiptap/pm/state';

import { aiUnitRangesIn, DOCUMENT_AI_RANGE, type AiUnitRanges } from '@web/spaces/document/document-ai-range';
import {
  aiAnswer,
  aiAnswerEmpty,
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
import { aimAt, type LocalRange } from '@web/spaces/document/document-local-range';
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
 * Opens the original range over some stretch, one stretch per unit, as the dialog does.
 * @param handle - The document.
 * @param range - The stretch.
 * @returns The selection, drawn in to its letters.
 */
function hold(handle: DocumentEditorHandle, range: LocalRange): LocalRange[] {
  const view = handle.editor.prosemirrorView!;
  const selected = aimAt(view.state.doc, [range]);
  view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, aiTextUnits(view.state.doc, selected).ranges));
  return selected;
}

/**
 * Each unit's words now.
 * @param handle - The document.
 * @returns Every unit's pieces; none once gone.
 */
function segments(handle: DocumentEditorHandle): AiUnitRanges {
  return aiUnitRangesIn(handle.editor.prosemirrorState);
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
  const selected = hold(handle, range);
  const doc = handle.editor.prosemirrorState.doc;
  const { units } = aiTextUnits(doc, selected);
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
  return aiAnswer(handle.editor, handle.editor.prosemirrorState.doc, o.units, text, command, OURS, segments(handle));
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
    expect(legacy.map((u) => [u.kind, u.blockId, u.cell])).toEqual([['tableCell', 'legacy-table', { row: 0, col: 0, line: 0 }], ['tableCell', 'legacy-table', { row: 0, col: 1, line: 0 }]]);
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
  it('shows only answered units, ignores ids never sent, and shows a unit still being written as far as it came', async () => {
    const h = await open('one\n\ntwo\n\nthree');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'three').to }, 'refine');
    const answer = read(h, o, '<u id="1">ONE</u><u id="9">nine</u><u id="3">THR', 'refine');
    expect(answer.results.map((r) => r.unit.id)).toEqual([1, 3]);
    expect(answer.preview.map((b) => textOf(b as Seen))).toEqual(['ONE', 'THR']);
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
    const h = await open('## Head\n\n- [x] done item\n\n- alpha\n- two');
    style(h, 'Head', { textColor: 'red' });
    replaceWith(h, { from: rangeOf(h, 'Head').from, to: rangeOf(h, 'alpha').to }, 'refine', () => tagged({ 1: 'New head', 2: 'Done thing', 3: 'First' }));
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
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [
      { type: 'paragraph', content: 'first' },
      { type: 'image', props: { url: `${OURS}a.png` } },
      { type: 'paragraph' },
      { type: 'bulletListItem', children: [{ type: 'paragraph', content: 'kid' }] },
      { type: 'paragraph', content: 'second' },
    ] as never);
    const before = flat(h).map((b) => [b.id, b.type]);
    replaceWith(h, { from: rangeOf(h, 'first').from, to: rangeOf(h, 'second').to }, 'refine', () => tagged({ 1: 'FIRST', 2: 'KID', 3: 'SECOND' }));
    expect(flat(h).map((b) => [b.id, b.type])).toEqual(before);
    expect(flat(h).map(textOf)).toEqual(['FIRST', '', '', '', 'KID', 'SECOND']);
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

/**
 * Types at a position, the way a keystroke lands, as its own undo step.
 * @param handle - The document.
 * @param pos - Where.
 * @param words - What.
 */
function type(handle: DocumentEditorHandle, pos: number, words: string): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(words, pos));
}

describe('writing as an ordinary edit', () => {
  it('replaces as one undo step, apart from the typing just before and just after', async () => {
    const h = await open('The quick brown fox.');
    type(h, rangeOf(h, 'fox.').to, ' Jumps.');
    replaceWith(h, rangeOf(h, 'quick brown'), 'refine', () => tagged({ 1: 'slow red' }));
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
    const o = opening(h, rangeOf(h, 'Target.'), 'refine');
    insertAiAnswer(h, blocks(h)[1]!.id, read(h, o, tagged({ 1: 'Inserted.' }), 'refine'), WRITABLE);
    type(h, rangeOf(h, 'Target.').to, ' Later');
    expect(blocks(h).map(textOf)).toEqual(['Typed here. More', 'Target. Later', 'Inserted.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['Typed here. More', 'Target.', 'Inserted.']);
    h.undoManager.undo();
    expect(blocks(h).map(textOf)).toEqual(['Typed here. More', 'Target.']);
  });

  it('replaces the words the dialog tracked after the body moved under them', async () => {
    const h = await open('The quick brown fox.');
    const o = opening(h, rangeOf(h, 'quick brown'), 'refine');
    type(h, rangeOf(h, 'The').from, 'Look: ');
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'slow red' }), 'refine'), segments(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Look: The slow red fox.']);
  });

  it.each([
    ['denied', 'readOnly'],
    ['unknown', 'failed'],
  ] as const)('writes nothing while the connection says %s', async (writeAccess, outcome) => {
    const h = await open('One.');
    const o = opening(h, rangeOf(h, 'One.'), 'refine');
    const answer = read(h, o, tagged({ 1: 'Two.' }), 'refine');
    const admission = (): ProposalAdmission => ({ available: true, writeAccess });
    expect(replaceAiAnswer(h, answer, segments(h), admission)).toEqual({ outcome });
    expect(insertAiAnswer(h, blocks(h)[0]!.id, answer, admission)).toEqual({ outcome });
    expect(blocks(h).map(textOf)).toEqual(['One.']);
  });

  it('inserts nothing once the insert block is gone', async () => {
    const h = await open('One.\n\nTwo.');
    const o = opening(h, rangeOf(h, 'Two.'), 'refine');
    const target = blocks(h)[1]!.id;
    h.editor.removeBlocks([target]);
    expect(insertAiAnswer(h, target, read(h, o, tagged({ 1: 'Three.' }), 'refine'), WRITABLE)).toEqual({ outcome: 'targetGone' });
    expect(blocks(h).map(textOf)).toEqual(['One.']);
  });

  it('inserts nothing for an answer of only outside media, and says how many', async () => {
    const h = await open('One.');
    const o = opening(h, rangeOf(h, 'One.'), 'custom');
    const answer = read(h, o, tagged({ 1: '![x](https://elsewhere.example/a.png)' }), 'custom');
    expect(insertAiAnswer(h, blocks(h)[0]!.id, answer, WRITABLE)).toEqual({ outcome: 'mediaOnly', leftOut: 1 });
    expect(blocks(h).map(textOf)).toEqual(['One.']);
  });

  it('inserts under the block in the cell when the selection stays in one docTable cell', async () => {
    const h = await open('Intro.\n\n| Shot | Action |\n| --- | --- |\n| Close | She turns |');
    const o = opening(h, rangeOf(h, 'She turns'), 'refine');
    const inCell = flat(h).find((b) => textOf(b) === 'She turns')!.id;
    insertAiAnswer(h, inCell, read(h, o, tagged({ 1: 'Added line.' }), 'refine'), WRITABLE);
    const table = blocks(h).find((b) => b.type === 'docTable')!;
    expect(table.children[1]!.children[1]!.children.map(textOf)).toEqual(['She turns', 'Added line.']);
    expect(blocks(h)).toHaveLength(2);
  });
});

/**
 * Puts a legacy table with any cells, lines and spans at the top of the body.
 * @param handle - The document.
 * @param rows - Each row's cells: their lines, and their attributes.
 */
function legacyGrid(handle: DocumentEditorHandle, rows: Array<Array<{ lines: string[]; attrs?: Record<string, unknown>; header?: boolean }>>): void {
  const view = handle.editor.prosemirrorView!;
  const s = view.state.schema;
  const line = (t: string): ReturnType<typeof s.node> => s.nodes['tableParagraph']!.create(null, t === '' ? [] : [s.text(t)]);
  const table = s.nodes['table']!.create(null, rows.map((row) => s.nodes['tableRow']!.create(null, row.map((cell) => s.nodes[cell.header === true ? 'tableHeader' : 'tableCell']!.create(cell.attrs ?? null, cell.lines.map(line))))));
  view.dispatch(view.state.tr.insert(1, s.nodes['blockContainer']!.create({ id: 'legacy-table' }, [table])));
  handle.undoManager.clear();
}

describe('reading an answer as it streams (A1, A5)', () => {
  it('shows the words of a unit whose tag is still open, without a half-written closing tag', async () => {
    const h = await open('one\n\ntwo');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'two').to }, 'refine');
    for (const [shown, words] of [
      ['<u id="1">Hi there', ['Hi there']],
      ['<u id="1">Hi there</', ['Hi there']],
      ['<u id="1">Hi</u>\n<u id="2">Tw', ['Hi', 'Tw']],
      ['<u id="1">Hi</u>\n<u id="2', ['Hi']],
    ] as const) {
      expect(read(h, o, shown, 'refine').preview.map((b) => textOf(b as Seen))).toEqual(words);
    }
  });

  it('shows nothing yet while a single unit answer has only begun its tag', async () => {
    const h = await open('Body');
    const o = opening(h, rangeOf(h, 'Body'), 'refine');
    for (const shown of ['<', '<u', '<u id="1"']) expect(read(h, o, shown, 'refine').preview).toEqual([]);
  });

  it('keeps what came of an open unit as a result to write', async () => {
    const h = await open('Body words');
    const o = opening(h, rangeOf(h, 'Body words'), 'refine');
    expect(aiAnswerEmpty('<u id="1">Better', o.units)).toBe(false);
    replaceAiAnswer(h, read(h, o, '<u id="1">Better', 'refine'), segments(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['Better']);
  });
});

describe('code keeps its whitespace (A6)', () => {
  it('writes the indentation of a code selection that starts on an indented line back as it came', async () => {
    const h = await open('```python\ndef f():\n    a = 1\n    return a\n```');
    const from = rangeOf(h, '    a = 1').from;
    replaceWith(h, { from, to: from + '    a = 1\n    return a'.length }, 'refine', (o) => echo(o.request));
    expect(textOf(blocks(h)[0]!)).toBe('def f():\n    a = 1\n    return a');
  });

  it('writes a whole code block echoed under custom back with every indentation space', async () => {
    const h = await open('```python\ndef f():\n    return 1\n```');
    const from = rangeOf(h, 'def f():').from;
    replaceWith(h, { from, to: from + 'def f():\n    return 1'.length }, 'custom', (o) => echo(o.request));
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['codeBlock', 'def f():\n    return 1']]);
  });
});

describe('table copies (A6, §5.3 insert)', () => {
  it('previews and inserts a copy of a docTable for a selection across its cells', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| cee | dee |');
    const o = opening(h, { from: rangeOf(h, 'cee').from, to: rangeOf(h, 'dee').to }, 'translate');
    const answer = read(h, o, tagged({ 1: 'C', 2: 'D' }), 'translate');
    expect(answer.preview.map((b) => (b as Seen).type)).toEqual(['docTable']);
    expect(insertAiAnswer(h, blocks(h)[0]!.id, answer, WRITABLE).outcome).toBe('written');
    const copy = blocks(h)[1]!;
    expect(copy.type).toBe('docTable');
    expect(copy.children.map((row) => row.children.map((cell) => cell.children.map(textOf).join('')))).toEqual([['a', 'b'], ['C', 'D']]);
  });

  it('copies the table when the selection runs into one of its cells from outside', async () => {
    const h = await open('above\n\n| first | b |\n| --- | --- |\n| cee | dee |');
    const o = opening(h, { from: rangeOf(h, 'above').from, to: rangeOf(h, 'first').to }, 'refine');
    const answer = read(h, o, tagged({ 1: 'ABOVE', 2: 'FIRST' }), 'refine');
    expect(answer.preview.map((b) => (b as Seen).type)).toEqual(['paragraph', 'docTable']);
  });

  it('copies a legacy table when the selection runs out of one of its cells, and when only some cells are answered', async () => {
    const h = await open('below');
    legacyTable(h, [['x', 'y']]);
    const out = opening(h, { from: rangeOf(h, 'y').from, to: rangeOf(h, 'below').to }, 'refine');
    expect(read(h, out, tagged({ 1: 'Y', 2: 'BELOW' }), 'refine').preview.map((b) => (b as Seen).type)).toEqual(['docTable', 'paragraph']);
    const both = opening(h, { from: rangeOf(h, 'x').from, to: rangeOf(h, 'y').to }, 'translate');
    const answer = read(h, both, tagged({ 1: 'X', 2: '' }), 'translate');
    expect(answer.preview.map((b) => (b as Seen).type)).toEqual(['docTable']);
    const copy = answer.preview[0] as Seen;
    expect(copy.children[0]!.children.map((cell) => cell.children.map(textOf).join(''))).toEqual(['X', 'y']);
  });

  it('copies a legacy cell spanning columns with its span', async () => {
    const h = await open('');
    legacyGrid(h, [[{ lines: ['head'], header: true, attrs: { colspan: 2 } }], [{ lines: ['x'] }, { lines: ['y'] }]]);
    const o = opening(h, { from: rangeOf(h, 'x').from, to: rangeOf(h, 'y').to }, 'refine');
    const copy = read(h, o, tagged({ 1: 'X', 2: 'Y' }), 'refine').preview[0] as Seen;
    expect(copy.children[0]!.children[0]!.props['colspan']).toBe(2);
  });
});

describe('a legacy cell holding several lines (A6)', () => {
  it('makes each line its own unit and writes each answer into its own line', async () => {
    const h = await open('');
    legacyGrid(h, [[{ lines: ['alpha', 'beta'] }, { lines: ['gamma'] }]]);
    const o = opening(h, { from: rangeOf(h, 'alpha').from, to: rangeOf(h, 'gamma').to }, 'refine');
    expect([...sent(o.request).values()]).toEqual(['alpha', 'beta', 'gamma']);
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'ALPHA', 2: 'BETA', 3: 'GAMMA' }), 'refine'), segments(h), WRITABLE);
    const lines: string[] = [];
    h.editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'tableParagraph') lines.push(node.textContent);
      return true;
    });
    expect(lines).toEqual(['ALPHA', 'BETA', 'GAMMA']);
  });
});

describe('the escape pair, inline content (§5.1)', () => {
  it('takes out a backslash the model put before punctuation the parser leaves alone', async () => {
    const h = await open('Body');
    const o = opening(h, rangeOf(h, 'Body'), 'shorten');
    expect(read(h, o, tagged({ 1: 'Monday\\\'s plan: \\"go\\" \\= done' }), 'shorten').preview.map((b) => textOf(b as Seen))).toEqual(['Monday\'s plan: "go" = done']);
  });

  it('decodes every character reference a model writes', async () => {
    const h = await open('Body');
    const o = opening(h, rangeOf(h, 'Body'), 'refine');
    expect(read(h, o, tagged({ 1: 'don&#39;t &quot;q&quot; a&nbsp;b &#x41;' }), 'refine').preview.map((b) => textOf(b as Seen))).toEqual(['don\'t "q" a b A']);
  });

  it.each([
    ['a plain web address', [{ type: 'text', text: 'docs at https://docs.example.com/v1.2/start now', styles: {} }]],
    ['bold that starts at a space', [{ type: 'text', text: 'see', styles: {} }, { type: 'text', text: ' this', styles: { bold: true } }, { type: 'text', text: ' now', styles: {} }]],
    ['italic and strikethrough that start at a space', [{ type: 'text', text: 'x', styles: {} }, { type: 'text', text: ' a', styles: { italic: true } }, { type: 'text', text: ' b', styles: { strike: true } }]],
    ['italic right before bold', [{ type: 'text', text: 'x', styles: {} }, { type: 'text', text: 'a', styles: { italic: true } }, { type: 'text', text: 'b', styles: { bold: true } }, { type: 'text', text: 'y', styles: {} }]],
    ['inline code with a space at each end', [{ type: 'text', text: 'run', styles: {} }, { type: 'text', text: ' x ', styles: { code: true } }, { type: 'text', text: 'now', styles: {} }]],
    ['a hard-broken line of equals signs', [{ type: 'text', text: 'title\n===', styles: {} }]],
    ['italic words right before a bold link', [{ type: 'text', text: 'see', styles: { italic: true } }, { type: 'link', href: 'https://a.example/', content: [{ type: 'text', text: 'docs', styles: { bold: true } }] }, { type: 'text', text: '.', styles: {} }]],
    ['an italic link right before bold words', [{ type: 'link', href: 'https://a.example/', content: [{ type: 'text', text: 'docs', styles: { italic: true } }] }, { type: 'text', text: ' new', styles: { bold: true } }]],
    ['a link whose words are italic then bold', [{ type: 'text', text: 'see ', styles: {} }, { type: 'link', href: 'https://a.example/', content: [{ type: 'text', text: 'a', styles: { italic: true } }, { type: 'text', text: 'b', styles: { bold: true } }] }, { type: 'text', text: ' z', styles: {} }]],
    ['an italic sentence holding an italic link', [{ type: 'text', text: 'See the ', styles: { italic: true } }, { type: 'link', href: 'https://a.example/', content: [{ type: 'text', text: 'docs', styles: { italic: true } }] }, { type: 'text', text: ' for details.', styles: { italic: true } }]],
    ['the words of the run marker in bold', [{ type: 'text', text: 'a ', styles: {} }, { type: 'text', text: '&aibreak;', styles: { bold: true } }, { type: 'text', text: ' b', styles: {} }]],
    ['an ideographic space starting a line', [{ type: 'text', text: '\u3000段落开头', styles: {} }]],
    ['no-break spaces at both ends', [{ type: 'text', text: '\u00a0a\u00a0', styles: {} }]],
  ])('writes %s back unchanged when echoed, under a fixed command and under custom', async (_name, content) => {
    for (const command of ['refine', 'custom'] as const) {
      const h = await open('');
      h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content }] as never);
      const before = structuredClone(blocks(h));
      const doc = h.editor.prosemirrorState.doc;
      replaceWith(h, { from: 1, to: doc.content.size - 1 }, command, (o) => echo(o.request));
      expect(blocks(h)).toEqual(before);
    }
  });
});

describe('edits made while the dialog is open (A7)', () => {
  it('keeps replace available after the body was split or written into inside the selection: the user decides, and undo takes it back', async () => {
    const h = await open('one two three');
    const o = opening(h, rangeOf(h, 'one two three'), 'refine');
    const view = h.editor.prosemirrorView!;
    view.dispatch(view.state.tr.split(rangeOf(h, 'three').from, 2));
    const answer = read(h, o, tagged({ 1: 'ONE TWO THREE' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
    const g = await open('');
    g.editor.replaceBlocks(g.editor.document, [{ type: 'paragraph', content: 'one' }, { type: 'paragraph' }, { type: 'paragraph', content: 'three' }] as never);
    const o2 = opening(g, { from: rangeOf(g, 'one').from, to: rangeOf(g, 'three').to }, 'refine');
    const empty = flat(g)[1]!;
    g.editor.updateBlock(empty.id, { content: 'typed' } as never);
    const a2 = read(g, o2, tagged({ 1: 'ONE', 2: 'THREE' }), 'refine');
    expect(aiReplaceAvailable(g.editor.prosemirrorState.doc, a2, segments(g))).toBe(true);
    replaceAiAnswer(g, a2, segments(g), WRITABLE);
    expect(blocks(g).map(textOf)).toEqual(['ONE', 'typed', 'THREE']);
  });
});

describe('round 10: answers and inline content', () => {
  it('ends a unit at the next opening tag when its closing tag is missing', async () => {
    const h = await open('one\n\ntwo\n\nthree');
    const o = opening(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'three').to }, 'refine');
    const answer = read(h, o, '<u id="1">ONE</u>\n<u id="2">TWO\n<u id="3">THREE</u>', 'refine');
    expect(answer.preview.map((b) => textOf(b as Seen))).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it('sends a backslash as one entity the model can read', async () => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: 'C:\\Users\\me' }] as never);
    expect([...sent(opening(h, rangeOf(h, 'C:\\Users\\me'), 'custom').request).values()]).toEqual(['C:&#92;Users&#92;me']);
  });

  it('reads a model\'s CommonMark escapes once', async () => {
    const h = await open('Hello world');
    const o = opening(h, rangeOf(h, 'Hello world'), 'refine');
    expect(read(h, o, tagged({ 1: 'a\\\\\\_b \\# c\\\\' }), 'refine').preview.map((b) => textOf(b as Seen))).toEqual(['a\\_b # c\\']);
  });

  it('writes a docTable copy with nested child answers and children kept under a split answer', async () => {
    const h = await open('| a | b |\n| --- | --- |\n| c | other |');
    const cell = flat(h).find((b) => textOf(b) === 'c')!;
    h.editor.replaceBlocks([cell.id], [{ type: 'paragraph', content: 'parent', children: [{ type: 'paragraph', content: 'child' }] }] as never);
    const o = opening(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'other').to }, 'expand');
    const answer = read(h, o, tagged({ 1: 'P1\n\nP2', 2: 'CHILD', 3: 'OTHER' }), 'expand');
    const copy = answer.preview[0] as Seen;
    const copied = copy.children[1]!.children[0]!.children.map((b) => [textOf(b), b.children.map(textOf)]);
    expect(copied).toEqual([['P1', []], ['P2', ['CHILD']]]);
  });
});

/**
 * Puts a comment on some words.
 * @param handle - The document.
 * @param words - The words.
 * @param threadId - The comment's thread.
 */
function comment(handle: DocumentEditorHandle, words: string, threadId: string): void {
  const view = handle.editor.prosemirrorView!;
  const { from, to } = rangeOf(handle, words);
  view.dispatch(view.state.tr.addMark(from, to, view.state.schema.marks['comment']!.create({ threadId, orphan: false })));
  handle.undoManager.clear();
}

/**
 * The commented words, as `thread:words`.
 * @param handle - The document.
 * @returns Them, in order.
 */
function commented(handle: DocumentEditorHandle): string[] {
  const out: string[] = [];
  handle.editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === 'comment') out.push(`${String(mark.attrs['threadId'])}:${node.text ?? ''}`);
  });
  return out;
}

/**
 * The body's blocks as words and depth.
 * @param list - The blocks.
 * @param depth - Their depth.
 * @returns `[words, depth]` for each, children after their parent.
 */
function shape(list: readonly Seen[], depth = 0): Array<[string, number]> {
  return list.flatMap((b): Array<[string, number]> => [[textOf(b), depth], ...shape(b.children ?? [], depth + 1)]);
}

/**
 * Presses Enter in the body where some words start, as the user would.
 * @param handle - The document.
 * @param at - Where.
 */
function enterAt(handle: DocumentEditorHandle, at: number): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: 'Enter' })));
}

describe('round 11: what a write keeps', () => {
  it('keeps the comments on the words left out and on the children when a unit is split', async () => {
    const h = await open('- alpha beta gamma\n  - kid words');
    comment(h, 'gamma', 't1');
    comment(h, 'kid', 't2');
    replaceWith(h, rangeOf(h, 'alpha'), 'custom', () => tagged({ 1: '- x\n- y' }));
    expect(flat(h).map(textOf)).toEqual(['x', 'y', ' beta gamma', 'kid words']);
    expect(commented(h)).toEqual(['t1:gamma', 't2:kid']);
    const g = await open('alpha beta gamma');
    comment(g, 'gamma', 't1');
    replaceWith(g, rangeOf(g, 'alpha'), 'expand', () => tagged({ 1: 'One.\n\nTwo.' }));
    expect(flat(g).map(textOf)).toEqual(['One.', 'Two.', ' beta gamma']);
    expect(commented(g)).toEqual(['t1:gamma']);
  });

  it('previews and inserts nested units with the nesting replace keeps', async () => {
    const h = await open('- parent\n  - child\n    - grandchild');
    const range = { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'grandchild').to };
    const o = opening(h, range, 'refine');
    const answer = read(h, o, tagged({ 1: 'PARENT', 2: 'CHILD', 3: 'GRAND' }), 'refine');
    const nested = [['PARENT', 0], ['CHILD', 1], ['GRAND', 2]];
    expect(shape(answer.preview as Seen[])).toEqual(nested);
    expect(insertAiAnswer(h, blocks(h)[0]!.id, answer, WRITABLE).outcome).toBe('written');
    expect(shape(blocks(h)).slice(3)).toEqual(nested);
    h.undoManager.undo();
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual(nested);
  });

  it('nests a unit under the last block of its answered parent, and lifts it past an unselected one', async () => {
    const h = await open('- top\n  - middle\n    - low');
    const o = opening(h, { from: rangeOf(h, 'top').from, to: rangeOf(h, 'low').to }, 'expand');
    const answer = read(h, o, tagged({ 1: 'TOP', 3: 'LOW' }), 'expand');
    expect(shape(answer.preview as Seen[])).toEqual([['TOP', 0], ['LOW', 1]]);
  });

  it('keeps quote, colour and alignment on every nested block of a custom answer', async () => {
    const h = await open('one two');
    style(h, 'one two', { quoted: true, textColor: 'red', textAlignment: 'center' });
    replaceWith(h, rangeOf(h, 'one two'), 'custom', () => tagged({ 1: '- a\n  - b\n    - c' }));
    const kept = flat(h).map((b) => [textOf(b), b.props['quoted'], b.props['textColor'], b.props['textAlignment']]);
    expect(kept).toEqual([['a', true, 'red', 'center'], ['b', true, 'red', 'center'], ['c', true, 'red', 'center']]);
  });

  it('writes back a link address holding white space or an entity when the model echoes it', async () => {
    for (const href of ['https://a.example/my file.pdf', 'https://a.example/?q=a&amp;b', 'https://a.example/a\'b c\'']) {
      for (const command of ['refine', 'custom'] as const) {
        const h = await open('');
        h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: [{ type: 'text', text: 'see ', styles: {} }, { type: 'link', href, content: 'file' }] }] as never);
        h.undoManager.clear();
        const before = structuredClone(blocks(h));
        const o = opening(h, { from: rangeOf(h, 'see').from, to: rangeOf(h, 'file').to }, command);
        replaceAiAnswer(h, read(h, o, echo(o.request), command), segments(h), WRITABLE);
        expect(blocks(h)).toEqual(before);
      }
    }
  });
});

describe('round 11: where a unit is', () => {
  it('follows the selected words into the block Enter made at their start, and writes there', async () => {
    const h = await open('intro selected words');
    const o = opening(h, rangeOf(h, 'selected words'), 'refine');
    enterAt(h, rangeOf(h, 'selected words').from);
    expect(blocks(h).map(textOf)).toEqual(['intro ', 'selected words']);
    const answer = read(h, o, tagged({ 1: 'SELECTED WORDS' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['intro ', 'SELECTED WORDS']);
  });

  it('follows the words for a structural answer too, the words before them kept', async () => {
    const h = await open('intro selected words');
    const o = opening(h, rangeOf(h, 'selected words'), 'custom');
    enterAt(h, rangeOf(h, 'selected words').from);
    replaceAiAnswer(h, read(h, o, tagged({ 1: '- a\n- b' }), 'custom'), segments(h), WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['paragraph', 'intro '], ['bulletListItem', 'a'], ['bulletListItem', 'b']]);
  });

  it('never takes the next unit\'s words for a unit whose own words were deleted', async () => {
    const h = await open('intro selected\n\nnext');
    const o = opening(h, { from: rangeOf(h, 'selected').from, to: rangeOf(h, 'next').to }, 'refine');
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'selected');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    const answer = read(h, o, tagged({ 1: 'SELECTED', 2: 'NEXT' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(false);
  });
});

/**
 * Presses a key in the body at a position, as the user would.
 * @param handle - The document.
 * @param at - Where.
 * @param key - The key.
 */
function pressKey(handle: DocumentEditorHandle, at: number, key: string): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key })));
}

/**
 * Puts a legacy table of one cell holding some lines at the top of the body.
 * @param handle - The document.
 * @param lines - The cell's lines.
 */
function legacyCell(handle: DocumentEditorHandle, lines: string[]): void {
  const view = handle.editor.prosemirrorView!;
  const s = view.state.schema;
  const cell = s.nodes['tableCell']!.create(null, lines.map((t) => s.nodes['tableParagraph']!.create(null, [s.text(t)])));
  const table = s.nodes['table']!.create(null, [s.nodes['tableRow']!.create(null, [cell])]);
  view.dispatch(view.state.tr.insert(1, s.nodes['blockContainer']!.create({ id: 'legacy-table' }, [table])));
  handle.undoManager.clear();
}

describe('round 12: each unit follows its own words', () => {
  it('writes each unit into its own words after the two blocks were joined with Backspace', async () => {
    for (const both of [false, true]) {
      const h = await open('alpha one\n\nbeta two');
      const o = opening(h, { from: rangeOf(h, 'alpha one').from, to: rangeOf(h, 'beta two').to }, 'translate');
      pressKey(h, rangeOf(h, 'beta two').from, 'Backspace');
      expect(blocks(h).map(textOf)).toEqual(['alpha onebeta two']);
      const answer = read(h, o, both ? tagged({ 1: 'ALPHA ONE', 2: 'BETA TWO' }) : tagged({ 1: 'ALPHA ONE' }), 'translate');
      expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
      expect(answer.preview.map((b) => textOf(b as Seen))).toEqual([both ? 'ALPHA ONEBETA TWO' : 'ALPHA ONE']);
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect(blocks(h).map(textOf)).toEqual([both ? 'ALPHA ONEBETA TWO' : 'ALPHA ONEbeta two']);
    }
  });

  it('writes each legacy cell line into its own words after a line was split above them', async () => {
    for (const skip of [false, true]) {
      const h = await open('tail');
      legacyCell(h, ['head note', 'alpha', 'beta']);
      const o = opening(h, { from: rangeOf(h, 'alpha').from, to: rangeOf(h, 'beta').to }, 'refine');
      const view = h.editor.prosemirrorView!;
      view.dispatch(view.state.tr.split(rangeOf(h, 'note').from));
      const answer = read(h, o, skip ? tagged({ 2: 'BETA' }) : tagged({ 1: 'ALPHA', 2: 'BETA' }), 'refine');
      expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect(legacyCells(h)).toEqual([[skip ? 'head \nnote\nalpha\nBETA' : 'head \nnote\nALPHA\nBETA']]);
    }
  });

  it('follows the words Enter carried out of a closed toggle heading, its children kept above', async () => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{ type: 'heading', props: { level: 2, isToggleable: true }, content: 'intro selected words', children: [{ type: 'paragraph', content: 'kid' }] }] as never);
    h.undoManager.clear();
    const o = opening(h, rangeOf(h, 'selected words'), 'refine');
    pressKey(h, rangeOf(h, 'selected words').from, 'Enter');
    expect(shape(blocks(h))).toEqual([['intro ', 0], ['kid', 1], ['selected words', 0]]);
    const answer = read(h, o, tagged({ 1: 'SELECTED WORDS' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['intro ', 0], ['kid', 1], ['SELECTED WORDS', 0]]);
  });

  it('turns replace off once a unit lost its words, whatever was typed into the lines between', async () => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: 'alpha' }, { type: 'paragraph' }, { type: 'paragraph', content: 'beta' }] as never);
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'alpha').from, to: rangeOf(h, 'beta').to }, 'refine');
    h.editor.updateBlock(blocks(h)[1]!.id, { content: 'my note' } as never);
    const view = h.editor.prosemirrorView!;
    const gone = rangeOf(h, 'alpha');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    const answer = read(h, o, tagged({ 1: 'ALPHA', 2: 'BETA' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(false);
  });

  it('turns replace off once every selected word is deleted, words typed among them included', async () => {
    const h = await open('left ABCDEF right');
    const o = opening(h, rangeOf(h, 'ABCDEF'), 'refine');
    const view = h.editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('yz', rangeOf(h, 'DEF').from));
    const answer = read(h, o, tagged({ 1: 'NEW' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
    view.dispatch(view.state.tr.delete(rangeOf(h, 'ABC').from, rangeOf(h, 'ABC').to));
    view.dispatch(view.state.tr.delete(rangeOf(h, 'DEF').from, rangeOf(h, 'DEF').to));
    expect(blocks(h).map(textOf)).toEqual(['left yz right']);
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(false);
  });

  it('writes over the words typed among the selected ones, as one stretch', async () => {
    const h = await open('left ABCDEF right');
    const o = opening(h, rangeOf(h, 'ABCDEF'), 'refine');
    const view = h.editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('yz', rangeOf(h, 'DEF').from));
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'NEW' }), 'refine'), segments(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['left NEW right']);
  });
});

describe('round 12: what a write keeps', () => {
  it('writes over a whole block that starts with a hard break inside the selection, the break included', async () => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: '\ntwo' }, { type: 'paragraph', content: 'three' }] as never);
    h.undoManager.clear();
    replaceWith(h, { from: rangeOf(h, 'one').from, to: rangeOf(h, 'three').to }, 'refine', () => tagged({ 1: 'ONE', 2: 'TWO', 3: 'THREE' }));
    expect(blocks(h).map(textOf)).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it('puts the children after a table the answer ends in, in replace, preview and insert alike', async () => {
    const table = '| p | q |\n| --- | --- |\n| r | s |';
    const h = await open('- item words\n  - kid words');
    const o = opening(h, rangeOf(h, 'item words'), 'custom');
    const answer = read(h, o, tagged({ 1: table }), 'custom');
    expect(replaceAiAnswer(h, answer, segments(h), WRITABLE).outcome).toBe('written');
    expect(blocks(h).map((b) => [b.type, textOf(b)])).toEqual([['docTable', ''], ['bulletListItem', 'kid words']]);
    const g = await open('- item words\n  - kid words');
    const o2 = opening(g, { from: rangeOf(g, 'item words').from, to: rangeOf(g, 'kid words').to }, 'custom');
    const a2 = read(g, o2, tagged({ 1: table, 2: '- KID' }), 'custom');
    expect((a2.preview as Seen[]).map((b) => [b.type, textOf(b)])).toEqual([['docTable', ''], ['bulletListItem', 'KID']]);
    expect(insertAiAnswer(g, blocks(g)[0]!.id, a2, WRITABLE).outcome).toBe('written');
    g.undoManager.undo();
    expect(replaceAiAnswer(g, a2, segments(g), WRITABLE).outcome).toBe('written');
    expect(blocks(g).map((b) => [b.type, textOf(b)])).toEqual([['docTable', ''], ['bulletListItem', 'KID']]);
  });

  it('writes a line break as code into a block turned into code while the dialog was open', async () => {
    const h = await open('# Title words');
    const o = opening(h, rangeOf(h, 'Title words'), 'refine');
    h.editor.updateBlock(blocks(h)[0]!.id, { type: 'codeBlock' } as never);
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'Title  \nwords' }), 'refine'), segments(h), WRITABLE);
    expect(blocks(h).map((b) => [b.type, textOf(b), b.children.length])).toEqual([['codeBlock', 'Title\nwords', 0]]);
  });

  it('writes back a link whose words are its address when the model echoes it', async () => {
    for (const href of ['tel:12345', '/docs/page', 'mailto:a@b.example']) {
      for (const command of ['refine', 'custom'] as const) {
        const h = await open('');
        h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: [{ type: 'text', text: 'call ', styles: {} }, { type: 'link', href, content: href }, { type: 'text', text: ' now', styles: {} }] }] as never);
        h.undoManager.clear();
        const before = structuredClone(blocks(h));
        const o = opening(h, { from: rangeOf(h, 'call').from, to: rangeOf(h, 'now').to }, command);
        replaceAiAnswer(h, read(h, o, echo(o.request), command), segments(h), WRITABLE);
        expect(blocks(h)).toEqual(before);
      }
    }
  });
});

/**
 * A table's cells, each as its blocks' words joined by `|`.
 * @param table - The table block.
 * @returns Its rows.
 */
function cellWords(table: Seen): string[][] {
  return table.children.map((row) => row.children.map((cell) => cell.children.map(textOf).join('|')));
}

describe('round 13: table copies find each unit where its words are', () => {
  it('previews and inserts a docTable copy with the answer where Enter carried the selected words', async () => {
    const h = await open('| intro selected | bbb |\n| --- | --- |\n| c | d |');
    const o = opening(h, { from: rangeOf(h, 'selected').from, to: rangeOf(h, 'bbb').to }, 'refine');
    pressKey(h, rangeOf(h, 'selected').from, 'Enter');
    const answer = read(h, o, tagged({ 1: 'SELECTED', 2: 'BBB' }), 'refine');
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['intro |SELECTED', 'BBB'], ['c', 'd']]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(cellWords(blocks(h).find((b) => b.type === 'docTable')!)).toEqual([['intro |SELECTED', 'BBB'], ['c', 'd']]);
  });

  it('previews a legacy table copy with each answer on the line that holds its words now', async () => {
    const h = await open('tail');
    const view = h.editor.prosemirrorView!;
    const s = view.state.schema;
    const cell = (lines: string[]): ReturnType<typeof s.node> => s.nodes['tableCell']!.create(null, lines.map((t) => s.nodes['tableParagraph']!.create(null, [s.text(t)])));
    const table = s.nodes['table']!.create(null, [s.nodes['tableRow']!.create(null, [cell(['head note', 'alpha']), cell(['beta'])])]);
    view.dispatch(view.state.tr.insert(1, s.nodes['blockContainer']!.create({ id: 'legacy-table' }, [table])));
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'alpha').from, to: rangeOf(h, 'beta').to }, 'refine');
    view.dispatch(view.state.tr.split(rangeOf(h, 'note').from));
    const answer = read(h, o, tagged({ 1: 'ALPHA', 2: 'BETA' }), 'refine');
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['head |note|ALPHA', 'BETA']]);
  });
});

describe('round 13: words typed over the selected ones', () => {
  it('turns replace off once the user typed over every selected word', async () => {
    const h = await open('left ABCDEF right');
    const o = opening(h, rangeOf(h, 'ABCDEF'), 'refine');
    const view = h.editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('mine', rangeOf(h, 'ABCDEF').from, rangeOf(h, 'ABCDEF').to));
    const answer = read(h, o, tagged({ 1: 'NEW' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(false);
  });

  it('keeps words typed over some selected ones out of the unit', async () => {
    const h = await open('left ABCDEF right');
    const o = opening(h, rangeOf(h, 'ABCDEF'), 'refine');
    const view = h.editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('mine', rangeOf(h, 'DEF').from, rangeOf(h, 'DEF').to));
    const doc = (): typeof h.editor.prosemirrorState.doc => h.editor.prosemirrorState.doc;
    expect(segments(h).map((unit) => unit.map(({ from, to }) => doc().textBetween(from, to)))).toEqual([['ABC']]);
    view.dispatch(view.state.tr.delete(rangeOf(h, 'ABC').from, rangeOf(h, 'ABC').to));
    const answer = read(h, o, tagged({ 1: 'NEW' }), 'refine');
    expect(aiReplaceAvailable(doc(), answer, segments(h))).toBe(false);
  });

  it('keeps a unit on its words when its line is retyped with the same words, as a change of block type does', async () => {
    const h = await open('# Title words');
    const o = opening(h, rangeOf(h, 'Title words'), 'refine');
    h.editor.updateBlock(blocks(h)[0]!.id, { type: 'paragraph' } as never);
    const answer = read(h, o, tagged({ 1: 'NEW' }), 'refine');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
  });
});

describe('round 14: units through block edits', () => {
  it('keeps a unit on its words when a line with marks, links or comments is turned into code', async () => {
    for (const md of ['plain **bold** words', 'plain [link](https://a.example) words']) {
      const h = await open(md);
      const o = opening(h, rangeOf(h, 'plain '), 'refine');
      h.editor.updateBlock(blocks(h)[0]!.id, { type: 'codeBlock' } as never);
      expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, read(h, o, tagged({ 1: 'X' }), 'refine'), segments(h))).toBe(true);
    }
    const h = await open('plain commented words');
    comment(h, 'commented', 't1');
    const o = opening(h, rangeOf(h, 'plain '), 'refine');
    h.editor.updateBlock(blocks(h)[0]!.id, { type: 'codeBlock' } as never);
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, read(h, o, tagged({ 1: 'X' }), 'refine'), segments(h))).toBe(true);
  });

  it('follows a child line joined into its parent, with Backspace and with Delete', async () => {
    for (const key of ['Backspace', 'Delete']) {
      const h = await open('');
      h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: 'parent words', children: [{ type: 'paragraph', content: 'child words' }] }] as never);
      h.undoManager.clear();
      const o = opening(h, { from: rangeOf(h, 'parent').from, to: rangeOf(h, 'child words').to }, 'refine');
      pressKey(h, key === 'Backspace' ? rangeOf(h, 'child words').from : rangeOf(h, 'parent words').to, key);
      expect(blocks(h).map(textOf)).toEqual(['parent wordschild words']);
      const answer = read(h, o, tagged({ 1: 'PARENT', 2: 'CHILD' }), 'refine');
      expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect(blocks(h).map(textOf)).toEqual(['PARENTCHILD']);
    }
  });

  it('replaces the selected words Enter moved to the next line too', async () => {
    const h = await open('one two three');
    const o = opening(h, rangeOf(h, 'one two three'), 'refine');
    pressKey(h, rangeOf(h, 'three').from, 'Enter');
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'ONE TWO THREE' }), 'refine'), segments(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['ONE TWO THREE']);
  });

  it('copies every answer of units joined into one block of a table cell, as replace writes them', async () => {
    const h = await open('| aaa | zzz |\n| --- | --- |\n| c | d |');
    const cell = flat(h).find((b) => textOf(b) === 'aaa')!;
    h.editor.replaceBlocks([cell.id], [{ type: 'paragraph', content: 'aaa' }, { type: 'paragraph', content: 'bbb' }] as never);
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'aaa').from, to: rangeOf(h, 'zzz').to }, 'refine');
    pressKey(h, rangeOf(h, 'bbb').from, 'Backspace');
    const answer = read(h, o, tagged({ 1: 'AAA', 2: 'BBB', 3: 'ZZZ' }), 'refine');
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['AAABBB', 'ZZZ'], ['c', 'd']]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(cellWords(blocks(h).find((b) => b.type === 'docTable')!)).toEqual([['AAABBB', 'ZZZ'], ['c', 'd']]);
  });
});

/**
 * Moves a block up, as the user would.
 * @param handle - The document.
 * @param id - The block.
 */
function moveUp(handle: DocumentEditorHandle, id: string): void {
  handle.editor.setTextCursorPosition(id);
  handle.editor.moveBlocksUp();
}

describe('round 15: copies and writes agree after the body moved', () => {
  it('copies a docTable without the selected words Enter moved out of a unit, as replace writes it', async () => {
    const h = await open('| one two three | bee |\n| --- | --- |\n| c | d |');
    const o = opening(h, { from: rangeOf(h, 'one two three').from, to: rangeOf(h, 'bee').to }, 'refine');
    pressKey(h, rangeOf(h, 'three').from, 'Enter');
    const answer = read(h, o, tagged({ 1: 'ONE TWO THREE', 2: 'BEE' }), 'refine');
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['ONE TWO THREE', 'BEE'], ['c', 'd']]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(cellWords(blocks(h).find((b) => b.type === 'docTable')!)).toEqual([['ONE TWO THREE', 'BEE'], ['c', 'd']]);
  });

  it('copies a legacy table with the line a unit\'s moved words left emptied, as replace writes it', async () => {
    const h = await open('tail');
    const view = h.editor.prosemirrorView!;
    const s = view.state.schema;
    const cell = (lines: string[]): ReturnType<typeof s.node> => s.nodes['tableCell']!.create(null, lines.map((t) => s.nodes['tableParagraph']!.create(null, [s.text(t)])));
    view.dispatch(view.state.tr.insert(1, s.nodes['blockContainer']!.create({ id: 'legacy-table' }, [s.nodes['table']!.create(null, [s.nodes['tableRow']!.create(null, [cell(['one two']), cell(['bee'])])])])));
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'one two').from, to: rangeOf(h, 'bee').to }, 'refine');
    view.dispatch(view.state.tr.split(rangeOf(h, 'two').from));
    const answer = read(h, o, tagged({ 1: 'ONE TWO', 2: 'BEE' }), 'refine');
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['ONE TWO|', 'BEE']]);
    const lines: string[] = [];
    h.editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name !== 'tableCell') return true;
      if (lines.length === 0) node.forEach((line) => lines.push(line.textContent));
      return false;
    });
    expect(lines).toEqual(['ONE TWO', '']);
  });

  it('joins the answers of units in one block in the order their words now stand', async () => {
    const h = await open('| aaa | zzz |\n| --- | --- |\n| c | d |');
    const cell = flat(h).find((b) => textOf(b) === 'aaa')!;
    h.editor.replaceBlocks([cell.id], [{ type: 'paragraph', content: 'aaa' }, { type: 'paragraph', content: 'bbb' }] as never);
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'aaa').from, to: rangeOf(h, 'zzz').to }, 'refine');
    moveUp(h, flat(h).find((b) => textOf(b) === 'bbb')!.id);
    pressKey(h, rangeOf(h, 'aaa').from, 'Backspace');
    const answer = read(h, o, tagged({ 1: 'AAA', 2: 'BBB', 3: 'ZZZ' }), 'refine');
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['BBBAAA', 'ZZZ'], ['c', 'd']]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(cellWords(blocks(h).find((b) => b.type === 'docTable')!)).toEqual([['BBBAAA', 'ZZZ'], ['c', 'd']]);
  });

  it('writes each unit where its words stand after the writes before it, when their stretches overlap', async () => {
    const h = await open('aa cc\n\nbb XX\n\ntail');
    const o = opening(h, { from: rangeOf(h, 'aa').from, to: rangeOf(h, 'XX').to }, 'refine');
    pressKey(h, rangeOf(h, 'cc').from, 'Enter');
    pressKey(h, rangeOf(h, 'XX').from, 'Enter');
    moveUp(h, blocks(h).find((b) => textOf(b) === 'bb ')!.id);
    pressKey(h, rangeOf(h, 'bb').from, 'Backspace');
    pressKey(h, rangeOf(h, 'cc').from, 'Backspace');
    expect(blocks(h).map(textOf)).toEqual(['aa bb cc', 'XX', 'tail']);
    const answer = read(h, o, tagged({ 1: 'ONE', 2: 'TWOOOOO' }), 'refine');
    expect(answer.preview.map((b) => textOf(b as Seen))).toEqual(['ONE']);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(blocks(h).map(textOf)).toEqual(['ONE', 'tail']);
  });

  it('keeps the children Enter carried with a unit\'s words under the unit\'s line', async () => {
    const h = await open('- one two\n  - kid');
    const o = opening(h, rangeOf(h, 'one two'), 'refine');
    pressKey(h, rangeOf(h, 'two').from, 'Enter');
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'ONE TWO' }), 'refine'), segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['ONE TWO', 0], ['kid', 1]]);
  });

  it('keeps a unit on its words when a line with a hard break is turned into code', async () => {
    const h = await open('');
    h.editor.replaceBlocks(h.editor.document, [{ type: 'paragraph', content: [{ type: 'text', text: 'a\nb ', styles: {} }, { type: 'text', text: 'bold', styles: { bold: true } }] }] as never);
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'a').from, to: rangeOf(h, 'bold').to }, 'refine');
    h.editor.updateBlock(blocks(h)[0]!.id, { type: 'codeBlock' } as never);
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, read(h, o, tagged({ 1: 'X' }), 'refine'), segments(h))).toBe(true);
  });
});

describe('round 16: every unit written after the body moved', () => {
  it('writes and previews a child unit whose line Enter carried away from its selected parent', async () => {
    const h = await open('- one two\n  - kid');
    const o = opening(h, { from: rangeOf(h, 'one two').from, to: rangeOf(h, 'kid').to }, 'refine');
    pressKey(h, rangeOf(h, 'two').from, 'Enter');
    const answer = read(h, o, tagged({ 1: 'ONE TWO', 2: 'KID' }), 'refine');
    expect(shape(answer.preview as Seen[])).toEqual([['ONE TWO', 0], ['KID', 1]]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['ONE TWO', 0], ['KID', 1]]);
  });

  it('writes and previews a unit nested with Tab under words Enter moved out of another unit', async () => {
    const h = await open('aa bb\n\ncc');
    const o = opening(h, { from: rangeOf(h, 'aa bb').from, to: rangeOf(h, 'cc').to }, 'refine');
    pressKey(h, rangeOf(h, 'bb').from, 'Enter');
    pressKey(h, rangeOf(h, 'cc').from, 'Tab');
    expect(shape(blocks(h))).toEqual([['aa ', 0], ['bb', 0], ['cc', 1]]);
    const answer = read(h, o, tagged({ 1: 'AA BB', 2: 'CC' }), 'refine');
    expect(shape(answer.preview as Seen[])).toEqual([['AA BB', 0], ['CC', 1]]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['AA BB', 0], ['CC', 1]]);
  });

  it('puts the children of a line emptied of moved words after the children of the line before', async () => {
    const h = await open('aa bb\n\ntail');
    const o = opening(h, rangeOf(h, 'aa bb'), 'refine');
    const view = h.editor.prosemirrorView!;
    /**
     * Writes a new child line after a line, as the user would: Enter at its end, Tab, then the words.
     * @param words - The line's words.
     * @param after - The line's words before, to find its end.
     */
    const child = (words: string, after: string): void => {
      pressKey(h, rangeOf(h, after).to, 'Enter');
      pressKey(h, view.state.selection.from, 'Tab');
      view.dispatch(view.state.tr.insertText(words));
    };
    pressKey(h, rangeOf(h, 'bb').from, 'Enter');
    child('new', 'aa ');
    child('kid', 'bb');
    expect(shape(blocks(h))).toEqual([['aa ', 0], ['new', 1], ['bb', 0], ['kid', 1], ['tail', 0]]);
    const answer = read(h, o, tagged({ 1: 'AA BB' }), 'refine');
    expect(shape(answer.preview as Seen[])).toEqual([['AA BB', 0]]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['AA BB', 0], ['new', 1], ['kid', 1], ['tail', 0]]);
  });

  it('writes the earlier unit too when units Backspace joined get answers of several blocks', async () => {
    const h = await open('alpha one\n\nbeta two\n\ntail');
    const o = opening(h, { from: rangeOf(h, 'alpha one').from, to: rangeOf(h, 'beta two').to }, 'expand');
    pressKey(h, rangeOf(h, 'beta two').from, 'Backspace');
    const answer = read(h, o, tagged({ 1: 'A1.\n\nA2.', 2: 'B1.\n\nB2.' }), 'expand');
    expect(shape(answer.preview as Seen[])).toEqual([['A1.', 0], ['A2.', 0], ['B1.', 0], ['B2.', 0]]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['A1.', 0], ['A2.', 0], ['B1.', 0], ['B2.', 0], ['tail', 0]]);
  });

  it('copies and writes both joined units of a table cell when the later answer is several blocks', async () => {
    const h = await open('| aaa | zzz |\n| --- | --- |\n| c | d |');
    const cell = flat(h).find((b) => textOf(b) === 'aaa')!;
    h.editor.replaceBlocks([cell.id], [{ type: 'paragraph', content: 'aaa' }, { type: 'paragraph', content: 'bbb' }] as never);
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'aaa').from, to: rangeOf(h, 'zzz').to }, 'expand');
    pressKey(h, rangeOf(h, 'bbb').from, 'Backspace');
    const answer = read(h, o, tagged({ 1: 'A1.\n\nA2.', 2: 'B1.\n\nB2.', 3: 'ZZZ' }), 'expand');
    expect(cellWords(answer.preview[0] as Seen)).toEqual([['A1.|A2.|B1.|B2.', 'ZZZ'], ['c', 'd']]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(cellWords(blocks(h).find((b) => b.type === 'docTable')!)).toEqual([['A1.|A2.|B1.|B2.', 'ZZZ'], ['c', 'd']]);
  });
});

/**
 * Each block's words, depth and kind, children after their parent.
 * @param list - The blocks.
 * @param depth - Their depth.
 * @returns `[words, depth, kind]` for each.
 */
function typedShape(list: readonly Seen[], depth = 0): Array<[string, number, string]> {
  return list.flatMap((b): Array<[string, number, string]> => [[textOf(b), depth, b.type], ...typedShape(b.children ?? [], depth + 1)]);
}

/** The edits that leave two units' stretches over each other: Enter, a move up, two Backspaces. */
function overlap(h: DocumentEditorHandle): void {
  pressKey(h, rangeOf(h, 'cc').from, 'Enter');
  pressKey(h, rangeOf(h, 'XX').from, 'Enter');
  moveUp(h, blocks(h).find((b) => textOf(b) === 'bb ')!.id);
  pressKey(h, rangeOf(h, 'bb').from, 'Backspace');
  pressKey(h, rangeOf(h, 'cc').from, 'Backspace');
}

describe('round 17: the preview is built from the body as replace leaves it', () => {
  it('previews units moved up in the order replace leaves them', async () => {
    const h = await open('aa\n\nbb\n\ntail');
    const o = opening(h, { from: rangeOf(h, 'aa').from, to: rangeOf(h, 'bb').to }, 'refine');
    moveUp(h, blocks(h).find((b) => textOf(b) === 'bb')!.id);
    const answer = read(h, o, tagged({ 1: 'AA', 2: 'BB' }), 'refine');
    expect(shape(answer.preview as Seen[])).toEqual([['BB', 0], ['AA', 0]]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['BB', 0], ['AA', 0], ['tail', 0]]);
  });

  it('previews a unit in the kind its line has now', async () => {
    const h = await open('alpha one\n\n## beta two\n\ntail');
    const o = opening(h, { from: rangeOf(h, 'alpha one').from, to: rangeOf(h, 'beta two').to }, 'refine');
    pressKey(h, rangeOf(h, 'beta two').from, 'Backspace');
    const answer = read(h, o, tagged({ 1: 'ALPHA ONE', 2: 'BETA TWO' }), 'refine');
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(typedShape(answer.preview as Seen[])).toEqual(typedShape(blocks(h)).slice(0, 2));
  });

  it('previews a cleared unit that keeps its children as replace leaves it', async () => {
    const h = await open('intro\n\n- aa\n  - kid\n\ntail');
    const o = opening(h, { from: rangeOf(h, 'intro').from, to: rangeOf(h, 'kid').to }, 'custom');
    const answer = read(h, o, tagged({ 1: 'INTRO AA', 2: '', 3: 'KID' }), 'custom');
    expect(typedShape(answer.preview as Seen[])).toEqual([['INTRO AA', 0, 'paragraph'], ['', 0, 'bulletListItem'], ['KID', 1, 'paragraph']]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(typedShape(blocks(h))).toEqual([['INTRO AA', 0, 'paragraph'], ['', 0, 'bulletListItem'], ['KID', 1, 'paragraph'], ['tail', 0, 'paragraph']]);
  });

  it('takes out a line emptied of moved words when Tab made it a first child', async () => {
    const h = await open('aa bb\n\ntail');
    const o = opening(h, rangeOf(h, 'aa bb'), 'refine');
    pressKey(h, rangeOf(h, 'bb').from, 'Enter');
    pressKey(h, rangeOf(h, 'bb').from, 'Tab');
    replaceAiAnswer(h, read(h, o, tagged({ 1: 'AA BB' }), 'refine'), segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['AA BB', 0], ['tail', 0]]);
  });

  it('puts the children of a first child emptied of moved words in its place', async () => {
    const h = await open('- one two\n  - kid\n- tail');
    const o = opening(h, { from: rangeOf(h, 'one two').from, to: rangeOf(h, 'kid').to }, 'refine');
    pressKey(h, rangeOf(h, 'two').from, 'Enter');
    pressKey(h, rangeOf(h, 'two').from, 'Tab');
    expect(shape(blocks(h))).toEqual([['one ', 0], ['two', 1], ['kid', 2], ['tail', 0]]);
    const answer = read(h, o, tagged({ 1: 'ONE TWO', 2: 'KID' }), 'refine');
    expect(shape(answer.preview as Seen[])).toEqual([['ONE TWO', 0], ['KID', 1]]);
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shape(blocks(h))).toEqual([['ONE TWO', 0], ['KID', 1], ['tail', 0]]);
  });

  it('previews the answers of three units joined into one line as replace splits and joins it', async () => {
    for (const parts of [{ 1: 'A1.', 2: 'B1.\n\nB2.', 3: 'C1.' }, { 1: 'A1.', 2: 'B1.', 3: 'C1.\n\nC2.' }, { 1: 'A1.\n\nA2.', 2: 'B1.', 3: 'C1.' }]) {
      const h = await open('aa\n\nbb\n\ncc\n\ntail');
      const o = opening(h, { from: rangeOf(h, 'aa').from, to: rangeOf(h, 'cc').to }, 'expand');
      pressKey(h, rangeOf(h, 'cc').from, 'Backspace');
      pressKey(h, rangeOf(h, 'bb').from, 'Backspace');
      expect(blocks(h).map(textOf)).toEqual(['aabbcc', 'tail']);
      const answer = read(h, o, tagged(parts), 'expand');
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect([...typedShape(answer.preview as Seen[]), ['tail', 0, 'paragraph']]).toEqual(typedShape(blocks(h)));
    }
  });

  it('copies a table with a cell line in the kind it has now, as replace writes it', async () => {
    const h = await open('| aaa | zzz |\n| --- | --- |\n| c | d |');
    const cell = flat(h).find((b) => textOf(b) === 'aaa')!;
    h.editor.replaceBlocks([cell.id], [{ type: 'heading', props: { level: 2 }, content: 'aaa' }] as never);
    h.undoManager.clear();
    const o = opening(h, { from: rangeOf(h, 'aaa').from, to: rangeOf(h, 'zzz').to }, 'refine');
    pressKey(h, rangeOf(h, 'aaa').from, 'Backspace');
    const answer = read(h, o, tagged({ 1: 'AAA', 2: 'ZZZ' }), 'refine');
    /**
     * The kind of the block holding some words, anywhere in a tree.
     * @param list - The blocks.
     * @param words - The words.
     * @returns Its kind.
     */
    const kindOf = (list: readonly Seen[], words: string): string | undefined => list.map((b) => (textOf(b) === words ? b.type : kindOf(b.children ?? [], words))).find((k) => k !== undefined);
    const shown = kindOf(answer.preview as Seen[], 'AAA');
    replaceAiAnswer(h, answer, segments(h), WRITABLE);
    expect(shown).toBe(kindOf(blocks(h), 'AAA'));
  });

  it('writes and previews units whose stretches lie over each other the same way, for answers of several blocks', async () => {
    for (const parts of [{ 1: '- one\n- two', 2: '- three\n- four' }, { 1: '- one\n- two', 2: 'TWO' }, { 1: 'ONE', 2: '- three\n- four' }]) {
      const h = await open('aa cc\n\nbb XX\n\ntail');
      const o = opening(h, { from: rangeOf(h, 'aa').from, to: rangeOf(h, 'XX').to }, 'custom');
      overlap(h);
      const answer = read(h, o, tagged(parts), 'custom');
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect(blocks(h).map(textOf)).not.toContain('cc');
      expect([...typedShape(answer.preview as Seen[]), ['tail', 0, 'paragraph']]).toEqual(typedShape(blocks(h)));
    }
  });
});

/**
 * Presses Tab with Shift in the body at a position, as the user would.
 * @param handle - The document.
 * @param at - Where.
 */
function shiftTab(handle: DocumentEditorHandle, at: number): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true })));
}

/** A line of the moving body: its words and kind, with lines nested under it. */
interface MovingLine {
  words: string;
  type: 'paragraph' | 'bulletListItem';
  kids: string[];
}

/** A body of lines, some with children, for the user to move around. */
const moving: fc.Arbitrary<MovingLine[]> = fc.array(
  fc.record({
    words: fc.stringMatching(/^[a-z]{1,4}( [a-z]{1,4}){0,2}$/),
    type: fc.constantFrom<'paragraph' | 'bulletListItem'>('paragraph', 'bulletListItem'),
    kids: fc.array(fc.stringMatching(/^[a-z]{1,4}( [a-z]{1,4}){0,1}$/), { maxLength: 2 }),
  }),
  { minLength: 1, maxLength: 4 },
);

/** What the user does while the dialog is open: a key or a block moved up, at a place picked from a number. */
const moves = fc.array(fc.tuple(fc.constantFrom('Enter', 'Backspace', 'Delete', 'Tab', 'ShiftTab', 'MoveUp'), fc.nat()), { maxLength: 4 });

describe('properties: the user moves the body while the dialog is open', () => {
  it('writes what the preview shows, once, whatever Enter, Backspace, Delete, Tab, Shift-Tab and moves did to the selected lines', async () => {
    const h = await open('');
    const kinds = fc.array(fc.constantFrom('one', 'several', 'none'), { minLength: 12, maxLength: 12 });
    await fc.assert(fc.asyncProperty(moving, moves, kinds, fc.constantFrom<Command>('expand', 'custom'), async (lines, keys, answers, command) => {
      h.editor.replaceBlocks(h.editor.document, lines.map((l) => ({
        type: l.type,
        content: l.words,
        children: l.kids.map((k) => ({ type: l.type, content: k })),
      })) as never);
      h.undoManager.clear();
      const o = opening(h, { from: 1, to: h.editor.prosemirrorState.doc.content.size - 1 }, command);
      for (const [key, n] of keys) {
        if (key === 'MoveUp') {
          const all = flat(h);
          moveUp(h, all[n % all.length]!.id);
          continue;
        }
        const doc = h.editor.prosemirrorState.doc;
        const at: number[] = [];
        doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          if (key === 'Enter') for (let i = 1; i < node.content.size; i += 1) at.push(pos + 1 + i);
          else at.push(key === 'Delete' ? pos + 1 + node.content.size : pos + 1);
          return false;
        });
        if (at.length === 0) continue;
        if (key === 'ShiftTab') shiftTab(h, at[n % at.length]!);
        else pressKey(h, at[n % at.length]!, key);
      }
      // Under expand an answer of several paragraphs; under custom a list, or nothing: merged into another.
      const kind = (id: number): string => (command === 'expand' && answers[id - 1] === 'none' ? 'several' : answers[id - 1]!);
      const marks = (id: number): string[] => (kind(id) === 'none' ? [] : kind(id) === 'several' ? [`U${String(id)}A.`, `U${String(id)}B.`] : [`U${String(id)}A.`]);
      const spelled = (id: number): string => (command === 'custom' && kind(id) === 'several' ? marks(id).map((m) => `- ${m}`).join('\n') : marks(id).join('\n\n'));
      const parts = Object.fromEntries(o.units.map((u) => [u.id, spelled(u.id)]));
      const answer = read(h, o, tagged(parts), command);
      if (!aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))) return;
      replaceAiAnswer(h, answer, segments(h), WRITABLE);
      expect(typedShape(blocks(h))).toEqual(typedShape(answer.preview as Seen[]));
      const now = flat(h).map(textOf);
      for (const r of answer.results) {
        for (const mark of marks(r.unit.id)) expect(now.filter((t) => t.includes(mark)).length).toBeLessThanOrEqual(1);
      }
    }), { numRuns: 80 });
  });
});

describe('round 11: replace with only outside media', () => {
  it('can be pressed, writes nothing and says how many were left out, as insert does', async () => {
    const h = await open('One.');
    const o = opening(h, rangeOf(h, 'One.'), 'custom');
    const answer = read(h, o, tagged({ 1: '![x](https://elsewhere.example/a.png)' }), 'custom');
    expect(aiReplaceAvailable(h.editor.prosemirrorState.doc, answer, segments(h))).toBe(true);
    expect(replaceAiAnswer(h, answer, segments(h), WRITABLE)).toEqual({ outcome: 'mediaOnly', leftOut: 1 });
    expect(blocks(h).map(textOf)).toEqual(['One.']);
  });
});

/** Words a model may send back, block syntax and escapes included. */
const tricky = fc.stringMatching(/^[a-z *_`#>\-+.1)([\]\\&<|=~!]{1,24}$/);

/** Words of one inline run: punctuation the parser reads, spaces, hard breaks, addresses. */
const runText = fc.oneof(
  { weight: 6, arbitrary: fc.stringMatching(/^[a-z *_`#>\-+.1)([\]\\&<|=~!:/\n]{1,12}$/) },
  { weight: 1, arbitrary: fc.constantFrom('https://docs.example.com/v1.2', ' see this ', '\n===', '&amp; &lt;b&gt;', '\u3000段落', 'a\u00a0', '&aibreak;', 'C:\\x') },
);

/** One inline run: words with any mix of the styles Markdown writes, or a link. */
const run = fc.oneof(
  // Inline code takes no other mark in the body's schema.
  { weight: 5, arbitrary: fc.record({ text: runText, styles: fc.oneof(fc.subarray(['bold', 'italic', 'strike'] as const), fc.constant(['code'] as const)) }) },
  { weight: 1, arbitrary: fc.record({ text: fc.stringMatching(/^[a-z_.]{1,6}$/), href: fc.constantFrom('https://a.example/x_(y)?a=1&b=2', 'https://docs.example.com/v1.2', 'https://a.example/my file.pdf', 'https://a.example/?q=a&amp;b'), styles: fc.subarray(['bold', 'italic', 'strike'] as const) }) },
);

/** A block of a body: one with words, an indented code block, an image or an empty line. */
type Seed = 'image' | 'empty' | { type: string; runs: Array<{ text: string; styles?: readonly string[]; href?: string }> } | { type: 'codeBlock'; code: string };

/** A block with words, of a kind the body holds. */
const wordy = fc.record({
  type: fc.constantFrom('paragraph', 'heading', 'bulletListItem', 'checkListItem', 'numberedListItem'),
  runs: fc.array(run, { minLength: 1, maxLength: 4 }),
}).filter((block) => block.runs.some((r) => r.text.trim() !== ''));

/** A code block whose lines are indented. */
const code = fc.array(fc.stringMatching(/^ {0,8}[a-z=(): *]{1,10}$/), { minLength: 1, maxLength: 3 }).map((lines) => ({ type: 'codeBlock' as const, code: lines.join('\n') }));

/** A body: blocks with words, code, images and empty lines mixed. */
const body: fc.Arbitrary<Seed[]> = fc.array(
  fc.oneof({ weight: 4, arbitrary: wordy }, { weight: 1, arbitrary: code }, { weight: 1, arbitrary: fc.constantFrom<'image' | 'empty'>('image', 'empty') }),
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
    if ('code' in seed) return { type: 'codeBlock', props: { language: 'python' }, content: seed.code };
    return {
      type: seed.type,
      content: seed.runs.map((r) => (r.href !== undefined
        ? { type: 'link', href: r.href, content: [{ type: 'text', text: r.text, styles: Object.fromEntries((r.styles ?? []).map((style) => [style, true])) }] }
        : { type: 'text', text: r.text, styles: Object.fromEntries((r.styles ?? []).map((style) => [style, true])) })),
    };
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
  return { before: doc.textBetween(start, span.from, undefined, '\n'), after: doc.textBetween(span.to, end, undefined, '\n') };
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

  it('reads any words a model escapes the CommonMark way back as those words', async () => {
    const h = await open('Body');
    const o = opening(h, rangeOf(h, 'Body'), 'refine');
    fc.assert(fc.property(fc.stringMatching(/^[a-z !-/:-@[-`{-~]{1,20}$/).filter((t) => t.trim() === t && t !== ''), (words) => {
      const escaped = words.replace(/[!-/:-@[-`{-~]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : `\\${c}`));
      expect(read(h, o, tagged({ 1: escaped }), 'refine').preview.map((b) => textOf(b as Seen))).toEqual([words]);
    }), { numRuns: 200 });
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
