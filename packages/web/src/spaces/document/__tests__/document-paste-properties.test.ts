// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The placement's invariants (inner#1351 design §5.4.6) on random bodies,
 * random content and the selections a reader can make: the reader's words
 * stay, put content never nests under the target, no block id repeats, the
 * caret ends in a line, a quoted target quotes what it takes, every medium
 * lands, and a drop lands as a paste at its point.
 */

import { tableBlock } from './table-fixtures';
import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { NodeSelection, TextSelection, type Selection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';

import { heldRange } from '@web/spaces/document/document-table-leave-selection';
import { serializeClipboard, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

import { OURS, open, pasteFormats, unmountAll, type Editor } from './paste-harness';
import { press, shape } from './paste-matrix';

afterEach(unmountAll);

/** Words the reader wrote use these letters; pasted words use the rest. */
const READER = /[a-m]/g;

const readerWords = fc.stringMatching(/^[a-m]{1,4}$/);
const pastedWords = fc.stringMatching(/^[n-z]{1,4}$/);

/** A body block, as the generator builds it. */
type BodyBlock = Record<string, unknown>;

const bodyBlock: fc.Arbitrary<BodyBlock> = fc.oneof(
  readerWords.map((content) => ({ type: 'paragraph', content })),
  readerWords.map((content) => ({ type: 'heading', content })),
  fc.constant({ type: 'paragraph' }),
  fc.constant({ type: 'heading' }),
  fc.constant({ type: 'bulletListItem' }),
  readerWords.map((content) => ({ type: 'paragraph', content, props: { quoted: true } })),
  fc.constant({ type: 'paragraph', props: { quoted: true } }),
  fc.tuple(readerWords, readerWords).map(([content, kid]) => ({ type: 'paragraph', content, children: [{ type: 'paragraph', content: kid }] })),
  fc.nat(99).map((n) => ({ type: 'image', props: { url: `${OURS}old${n}.png` } })),
  fc.tuple(readerWords, readerWords).map(([a, b]) => tableBlock({ rows: [{ cells: [a, b] }] })),
  readerWords.map((content) => ({ type: 'codeBlock', content })),
);

/** A piece of pasted content: a list item may nest a picture or another item last. */
type Piece =
  | { kind: 'words'; words: string }
  | { kind: 'medium' }
  | { kind: 'table'; words: string }
  | { kind: 'divider' }
  | { kind: 'listMedium'; words: string }
  | { kind: 'listWords'; words: string }
  | { kind: 'heading'; words: string };

const piece: fc.Arbitrary<Piece> = fc.oneof(
  pastedWords.map((words): Piece => ({ kind: 'words', words })),
  fc.constant<Piece>({ kind: 'medium' }),
  pastedWords.map((words): Piece => ({ kind: 'table', words })),
  fc.constant<Piece>({ kind: 'divider' }),
  pastedWords.map((words): Piece => ({ kind: 'listMedium', words })),
  pastedWords.map((words): Piece => ({ kind: 'listWords', words })),
  pastedWords.map((words): Piece => ({ kind: 'heading', words })),
);

/**
 * Whether a piece holds only lines of words, which BlockNote's own paste puts
 * as main does (§5.4.3).
 * @param p - The piece.
 * @returns True for words.
 */
function isWords(p: Piece): boolean {
  return p.kind === 'words' || p.kind === 'listWords' || p.kind === 'heading';
}

/**
 * Whether the last line of the pieces in reading order is a line of words:
 * a nested item counts as read after its parent, a table and a medium as
 * blocks of their own.
 * @param pieces - The pieces.
 * @returns True when the content ends in words.
 */
function endsInWords(pieces: readonly Piece[]): boolean {
  return isWords(pieces[pieces.length - 1]!);
}

/**
 * The pieces as blocks; media are named m0, m1… in order.
 * @param pieces - The pieces.
 * @returns The blocks.
 */
function blocksOf(pieces: readonly Piece[]): Record<string, unknown>[] {
  let n = 0;
  const media = (): string => `${OURS}m${n++}.png`;
  return pieces.map((p) => {
    switch (p.kind) {
      case 'medium': return { type: 'image', props: { url: media() } };
      case 'table': return tableBlock({ rows: [{ cells: [p.words] }] });
      case 'divider': return { type: 'divider' };
      case 'listMedium': return { type: 'bulletListItem', content: p.words, children: [{ type: 'image', props: { url: media() } }] };
      case 'listWords': return { type: 'bulletListItem', content: p.words, children: [{ type: 'bulletListItem', content: `${p.words}z` }] };
      case 'heading': return { type: 'heading', props: { level: 3 }, content: p.words };
      default: return { type: 'paragraph', content: p.words };
    }
  });
}

/** How the reader made the selection the paste replaces. */
type Aim =
  | { kind: 'caret'; at: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'block'; at: number }
  | { kind: 'gap'; at: number; key: 'ArrowLeft' | 'ArrowUp' }
  | { kind: 'cells'; at: number };

const aim: fc.Arbitrary<Aim> = fc.oneof(
  fc.nat().map((at): Aim => ({ kind: 'caret', at })),
  fc.tuple(fc.nat(), fc.nat()).map(([from, to]): Aim => ({ kind: 'range', from, to })),
  fc.nat().map((at): Aim => ({ kind: 'block', at })),
  fc.tuple(fc.nat(), fc.constantFrom<'ArrowLeft' | 'ArrowUp'>('ArrowLeft', 'ArrowUp')).map(([at, key]): Aim => ({ kind: 'gap', at, key })),
  fc.nat().map((at): Aim => ({ kind: 'cells', at })),
);

/**
 * Every position a click can put the caret at: inside a line's words.
 * @param doc - The document.
 * @returns The positions.
 */
function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) for (let i = 0; i <= node.content.size; i += 1) out.push(pos + 1 + i);
    return true;
  });
  return out;
}

/**
 * Where nodes of some types start.
 * @param doc - The document.
 * @param names - The types.
 * @returns The positions.
 */
function starts(doc: PMNode, names: readonly string[]): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (names.includes(node.type.name)) out.push(pos);
    return true;
  });
  return out;
}

/**
 * Makes the selection the way a reader makes it: a click, a drag, a click on
 * a picture, an arrow key off a selected picture, a drag across cells. Falls
 * back to a click when the body has nothing of that kind.
 * @param editor - The editor.
 * @param chosen - The aim.
 */
function select(editor: Editor, chosen: Aim): void {
  const view = editor.prosemirrorView;
  const { doc } = view.state;
  const text = textPositions(doc);
  const pick = <T,>(list: readonly T[], n: number): T => list[n % list.length]!;
  let selection: Selection = TextSelection.create(doc, pick(text, chosen.kind === 'range' ? chosen.from : chosen.at));
  if (chosen.kind === 'range') {
    selection = TextSelection.between(doc.resolve(pick(text, chosen.from)), doc.resolve(pick(text, chosen.to)));
    // A drag from one cell into another of the same table selects the cells (prosemirror-tables' mouse handling).
    const cellOf = (pos: number): number | null => {
      const $pos = doc.resolve(pos);
      for (let d = $pos.depth; d > 0; d -= 1) if ($pos.node(d).type.name === 'docTableCell') return $pos.before(d);
      return null;
    };
    const [a, b] = [cellOf(selection.from), cellOf(selection.to)];
    if (a !== null && b !== null && a !== b && doc.resolve(a).node(-1) === doc.resolve(b).node(-1)) selection = CellSelection.create(doc, a, b);
  }
  const blocks = starts(doc, ['image']);
  if ((chosen.kind === 'block' || chosen.kind === 'gap') && blocks.length > 0) selection = NodeSelection.create(doc, pick(blocks, chosen.at));
  // Two neighbouring cells of one table, as a drag across them selects.
  const pairs = starts(doc, ['docTableCell']).flatMap((cell) => {
    const next = cell + doc.nodeAt(cell)!.nodeSize;
    return doc.nodeAt(next)?.type.name === 'docTableCell' ? [[cell, next] as const] : [];
  });
  if (chosen.kind === 'cells' && pairs.length > 0) {
    const [a, b] = pick(pairs, chosen.at);
    selection = CellSelection.create(doc, a, b);
  }
  view.dispatch(view.state.tr.setSelection(selection));
  view.focus();
  if (chosen.kind === 'gap' && blocks.length > 0) press(editor, chosen.key);
}

/** How each source delivers the pieces. */
type Source = 'web' | 'own' | 'canvas';

/**
 * Pastes the pieces from a source; media are named m0, m1… in order.
 * @param editor - The editor.
 * @param pieces - The pieces.
 * @param source - The source.
 */
function paste(editor: Editor, pieces: readonly Piece[], source: Source): void {
  let n = 0;
  const media = (): string => `${OURS}m${n++}.png`;
  if (source === 'canvas') {
    const nodes = pieces.map((p, i): ClipboardNode =>
      p.kind === 'medium'
        ? ({ id: `n${i}`, type: 'image', position: { x: 0, y: i * 300 }, height: 100, data: { content: media() } })
        : ({
          id: `n${i}`,
          type: 'text',
          position: { x: 0, y: i * 300 },
          height: 100,
          data: { body: { $y: 'xml', children: [{ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: p.kind === 'words' ? p.words : 'x' }] }] }] } },
        }),
    );
    pasteFormats(editor, { 'text/plain': serializeClipboard({ version: 2, picked: nodes.map((x) => x.id), nodes, edges: [] } as ClipboardPayload) });
    return;
  }
  const html = editor.blocksToFullHTML(blocksOf(pieces) as never);
  pasteFormats(editor, source === 'own' ? { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' } : { 'text/html': html, 'text/plain': 'copied' });
}

/**
 * Every block container's id, depth, first child and the id of the
 * container it is nested in.
 * @param doc - The document.
 * @returns They.
 */
function containers(doc: PMNode): { id: string; depth: number; node: PMNode; parent: string | null }[] {
  const out: { id: string; depth: number; node: PMNode; parent: string | null }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer' && node.type.name !== 'docTable') return true;
    const $pos = doc.resolve(pos);
    let parent: string | null = null;
    for (let d = $pos.depth; d > 0 && parent === null; d -= 1) if ($pos.node(d).type.name === 'blockContainer') parent = String($pos.node(d).attrs['id']);
    out.push({ id: String(node.attrs['id']), depth: $pos.depth, node, parent });
    return true;
  });
  return out;
}

/**
 * How deep the block the selection aims at sits, and whether it is quoted.
 * @param selection - The selection.
 * @returns The depth of its container, and its quote.
 */
function aimed(selection: Selection): { depth: number; quoted: boolean; textOnly: boolean } {
  const $at = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
  let depth = -1;
  let quoted = false;
  let textOnly = false;
  for (let d = $at.depth; d > 0; d -= 1) {
    const node = $at.node(d);
    if (node.type.name === 'codeBlock') textOnly = true;
    if (node.type.name === 'blockContainer' && depth < 0) {
      depth = d - 1;
      quoted = node.firstChild?.attrs['quoted'] === true;
    }
  }
  if (selection instanceof NodeSelection && selection.node.type.name !== 'blockContainer') quoted = selection.node.attrs['quoted'] === true;
  if (selection instanceof CellSelection) depth = selection.$anchorCell.depth + 1;
  return { depth, quoted, textOnly };
}

/** A body with at least one line a click can put the caret in. */
const body = fc.array(bodyBlock, { minLength: 1, maxLength: 5 }).filter((blocks) => blocks.some((b) => b['type'] !== 'image'));

const property = fc.record({
  body,
  pieces: fc.array(piece, { minLength: 1, maxLength: 4 }).filter((p) => p.some((x) => !isWords(x))),
  source: fc.constantFrom<Source>('web', 'own', 'canvas'),
  aim,
});


/** A random case: a body, content, where it was copied from and how the reader aimed. */
interface Sample {
  readonly body: BodyBlock[];
  readonly pieces: Piece[];
  readonly source: Source;
  readonly aim: Aim;
}

/**
 * Puts a sample's content and checks every invariant.
 * @param sample - The sample.
 */
function checkPut({ body, pieces, source, aim: chosen }: Sample): void {

  const content = source === 'canvas' ? pieces.filter((p) => p.kind === 'words' || p.kind === 'medium') : pieces;
  if (!content.some((p) => !isWords(p))) return;
  const { editor, manager, sink } = open(body, { onCanvasPaste: { start: vi.fn(), notPasted: vi.fn() } });
  const view = editor.prosemirrorView;
  select(editor, chosen);
  const before = view.state;
  const { selection } = before;
  const target = aimed(selection);
  // A cell selection is one range per cell: what lies outside every range is what stays.
  const held = heldRange(selection);
  const ranges = held === null ? [...selection.ranges].sort((x, y) => x.$from.pos - y.$from.pos) : [{ $from: before.doc.resolve(held.from), $to: before.doc.resolve(held.to) }];
  let outsideText = '';
  let at = 0;
  for (const range of ranges) {
    outsideText += before.doc.textBetween(at, range.$from.pos, '');
    at = range.$to.pos;
  }
  outsideText += before.doc.textBetween(at, before.doc.content.size, '');
  const outside = outsideText.match(READER)?.join('') ?? '';
  const all = before.doc.textContent.match(READER)?.join('') ?? '';
  const oldIds = new Set(containers(before.doc).map((c) => c.id));
  const tableCount = content.filter((p) => p.kind === 'table').length;
  const targetAfterDelete = selection instanceof CellSelection ? selection.$anchorCell : before.tr.deleteSelection().selection.$from;
  let inCell = selection instanceof CellSelection;
  for (let d = targetAfterDelete.depth; d > 0; d -= 1) {
    if (['docTableCell', 'docTableHeader'].includes(targetAfterDelete.node(d).type.name)) inCell = true;
  }
  const rejected = inCell && tableCount > 0 && (tableCount > 1 || content.length > 1);
  const stackSize = manager.undoStack.length;
  paste(editor, content, source);
  const after = view.state;
  const where = `${source} ${JSON.stringify(body)} ${JSON.stringify(content)} ${selection.constructor.name}@${selection.from}-${selection.to} → ${shape(editor)}`;

  if (rejected) {
    expect(after.doc.toJSON(), where).toEqual(before.doc.toJSON());
    expect(after.selection.toJSON(), where).toEqual(selection.toJSON());
    expect(manager.undoStack, where).toHaveLength(stackSize);
    expect(sink.start, where).not.toHaveBeenCalled();
    unmountAll();
    return;
  }

  const kept = after.doc.textContent.match(READER)?.join('') ?? '';
  // A table pasted into a table fills its cells over what they held, as prosemirror-tables pastes cells (design §5.4.3).
  const fillsCells = tableCount === 1 && inCell;
  if (!fillsCells) expect([outside, all], `reader's words: ${where}`).toContain(kept);

  const placed = containers(after.doc).filter((c) => !oldIds.has(c.id));
  const ids = containers(after.doc).map((c) => c.id);
  expect(new Set(ids).size, `ids: ${where}`).toBe(ids.length);

  // A medium the content itself nests (a list item's picture) sits under its own item.
  const placedIds = new Set(placed.map((c) => c.id));
  const media = placed.filter((c) => (c.parent === null || !placedIds.has(c.parent)) && ['image', 'docTable', 'divider'].includes(c.node.type.name === 'docTable' ? c.node.type.name : c.node.firstChild!.type.name));
  // Across lines the target is the line left once the selection is deleted; the matrix covers that.
  const oneLine = !(selection instanceof TextSelection) || selection.$from.sameParent(selection.$to);
  if (!target.textOnly && oneLine) for (const c of media) expect(c.depth, `nested: ${where}`).toBe(target.depth);
  if (target.quoted && !target.textOnly && oneLine && !(selection instanceof NodeSelection)) {
    for (const c of placed) expect((c.node.type.name === 'docTable' ? c.node : c.node.firstChild!).attrs['quoted'], `quote: ${where}`).toBe(true);
  }

  const sel = after.selection;
  expect(sel instanceof CellSelection || (sel instanceof TextSelection && sel.$head.parent.isTextblock), `caret: ${where}`).toBe(true);

  let copies = 1;
  if (selection instanceof CellSelection && tableCount === 0) {
    copies = 0;
    selection.forEachCell(() => { copies += 1; });
  }
  const pasted = content.filter((p) => p.kind === 'medium' || p.kind === 'listMedium').length * copies;
  const landed = containers(after.doc).filter((c) => {
    const own = c.node.firstChild!;
    return own.type.name === 'image' && (/\/m\d+\.png$/.test(String(own.attrs['url'])) || String(own.attrs['uploadId'] ?? '') !== '');
  }).length;
  expect(landed, `media: ${where}`).toBe(pasted);
  unmountAll();
}

describe('content holding a medium, a table or a divider, put anywhere a reader can aim', () => {
  it('keeps the reader\'s words, nests nothing, repeats no id, ends the caret in a line, quotes as the target and lands every medium', () => {
    fc.assert(
      fc.property(property, checkPut),
      { numRuns: 400 },
    );
  });
});

describe('a drop', () => {
  it('lands as a paste at its point', () => {
    fc.assert(
      fc.property(
        fc.record({ body, pieces: fc.array(piece, { minLength: 1, maxLength: 4 }), at: fc.nat(), source: fc.constantFrom<Source>('web', 'own') }),
        ({ body, pieces, at, source }) => {
          const pasted = open(body).editor;
          const point = textPositions(pasted.prosemirrorView.state.doc)[at % textPositions(pasted.prosemirrorView.state.doc).length]!;
          pasted.prosemirrorView.dispatch(pasted.prosemirrorView.state.tr.setSelection(TextSelection.create(pasted.prosemirrorView.state.doc, point)));
          pasted.prosemirrorView.focus();
          paste(pasted, pieces, source);
          const expectedShape = shape(pasted);
          unmountAll();

          const dropped = open(body).editor;
          const view = dropped.prosemirrorView;
          const html = dropped.blocksToFullHTML(blocksOf(pieces) as never);
          const own = source === 'own' ? html : '';
          view.posAtCoords = (): { pos: number; inside: number } => ({ pos: point, inside: -1 });
          const formats: Record<string, string> = own === '' ? { 'text/html': html, 'text/plain': 'copied' } : { 'blocknote/html': own, 'text/html': html, 'text/plain': 'copied' };
          const event = new Event('drop', { bubbles: true, cancelable: true });
          Object.assign(event, { clientX: 1, clientY: 1 });
          Object.defineProperty(event, 'dataTransfer', { value: { types: Object.keys(formats), files: [], items: [], getData: (type: string): string => formats[type] ?? '' } });
          view.dom.dispatchEvent(event);
          expect(shape(dropped), `${source} ${JSON.stringify(body)} ${JSON.stringify(pieces)} @${point}`).toBe(expectedShape);
          unmountAll();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('a drag within the body', () => {
  it('lands as its copy pasted at the drop point', () => {
    fc.assert(
      fc.property(
        fc.record({ body, from: fc.nat(), to: fc.nat(), at: fc.nat() }),
        ({ body, from, to, at }) => {
          /**
           * Opens the body with a range selected and the drop point found.
           * @returns The editor and the drop point.
           */
          const ready = (): { editor: Editor; point: number } => {
            const editor = open(body).editor;
            const text = textPositions(editor.prosemirrorView.state.doc);
            select(editor, { kind: 'range', from, to });
            return { editor, point: text[at % text.length]! };
          };
          const pasted = ready();
          const pastedView = pasted.editor.prosemirrorView;
          const html = pastedView.serializeForClipboard(pastedView.state.selection.content()).dom.innerHTML;
          // A drop onto the dragged content itself is no paste, and a drag
          // holding no words and no block, a line break alone, puts nothing.
          const { from: start, to: end } = pastedView.state.selection;
          const dragged = pastedView.state.selection.content().content;
          if (dragged.textBetween(0, dragged.size, '', '\ufffc') === '' || (pasted.point >= start && pasted.point <= end)) {
            unmountAll();
            return;
          }
          pastedView.dispatch(pastedView.state.tr.setSelection(TextSelection.create(pastedView.state.doc, pasted.point)));
          pasteFormats(pasted.editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' });
          const expectedShape = shape(pasted.editor);
          unmountAll();

          const dropped = ready();
          const view = dropped.editor.prosemirrorView;
          (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: false };
          // The pointer inside the body's box: a drop beside it is re-sent by BlockNote's side menu without its keys.
          const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
          for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
          view.posAtCoords = (): { pos: number; inside: number } => ({ pos: dropped.point, inside: -1 });
          const event = new Event('drop', { bubbles: true, cancelable: true });
          Object.assign(event, { clientX: 1, clientY: 1, altKey: true, ctrlKey: true });
          Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/html'], files: [], items: [], getData: (): string => html } });
          view.dom.dispatchEvent(event);
          expect(shape(dropped.editor), `${JSON.stringify(body)} ${from}..${to} @${dropped.point}`).toBe(expectedShape);
          unmountAll();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('a drag within the body that moves its content', () => {
  it('leaves no row id twice and takes the content from where it was', () => {
    fc.assert(
      fc.property(
        fc.record({ body, from: fc.nat(), to: fc.nat(), at: fc.nat() }),
        ({ body, from, to, at }) => {
          const editor = open(body).editor;
          const view = editor.prosemirrorView;
          const text = textPositions(view.state.doc);
          select(editor, { kind: 'range', from, to });
          const point = text[at % text.length]!;
          const { from: start, to: end } = view.state.selection;
          const dragged = view.state.selection.content();
          if (start === end || (point >= start && point <= end)) {
            unmountAll();
            return;
          }
          view.dom.parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }));
          (view as unknown as { dragging: unknown }).dragging = { slice: dragged, move: true };
          const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
          for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
          view.posAtCoords = (): { pos: number; inside: number } => ({ pos: point, inside: -1 });
          const event = new Event('drop', { bubbles: true, cancelable: true });
          Object.assign(event, { clientX: 1, clientY: 1 });
          Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/html'], files: [], items: [], getData: (): string => '<p>x</p>' } });
          view.dom.dispatchEvent(event);
          const ids: unknown[] = [];
          view.state.doc.descendants((node) => {
            if (node.type.name === 'blockContainer') ids.push(node.attrs['id']);
            return true;
          });
          expect(ids.length - new Set(ids).size, `${JSON.stringify(body)} ${from}..${to} @${point}`).toBe(0);
          unmountAll();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('content put on an empty plain line (design §5.4.3)', () => {
  it('becomes that line when it ends in words, and leaves the line for the caret otherwise', () => {
    fc.assert(
      fc.property(
        fc.record({
          body,
          index: fc.nat(),
          inCell: fc.boolean(),
          pieces: fc.array(piece, { minLength: 1, maxLength: 4 }).filter((p) => p.some((x) => !isWords(x))),
          source: fc.constantFrom<Source>('web', 'own'),
        }),
        ({ body: blocks, index, inCell, pieces, source }) => {
          // A table in a cell is filled or refused (§5.4.7), not put on the line.
          if (inCell && pieces.some((p) => p.kind === 'table')) return;
          const line = { type: 'paragraph', id: 'emptyline' };
          const host = inCell ? [tableBlock({ rows: [{ cells: [{ blocks: [line] }, 'kept'] }] })] : [line];
          const at = index % (blocks.length + 1);
          const { editor } = open([...blocks.slice(0, at), ...host, ...blocks.slice(at)] as never);
          const view = editor.prosemirrorView;
          let linePos = -1;
          view.state.doc.descendants((node, pos) => {
            if (node.attrs['id'] === 'emptyline') linePos = pos;
            return linePos < 0;
          });
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, linePos + 2)));
          view.focus();
          paste(editor, pieces, source);
          const where = `${source} ${inCell ? 'cell' : 'body'} ${JSON.stringify(pieces)} → ${shape(editor)}`;
          const { doc, selection } = view.state;
          let taker: PMNode | null = null;
          doc.descendants((node) => {
            if (node.attrs['id'] === 'emptyline') taker = node;
            return taker === null;
          });
          expect(taker, `line id: ${where}`).not.toBeNull();
          const own = (taker as unknown as PMNode).firstChild!;
          if (endsInWords(pieces)) {
            const last = pieces[pieces.length - 1]!;
            const type = { words: 'paragraph', listWords: 'bulletListItem', heading: 'heading' }[last.kind as 'words' | 'listWords' | 'heading'];
            let lastLine: PMNode | null = null;
            (taker as unknown as PMNode).descendants((node) => {
              if (node.isTextblock) lastLine = node;
              return true;
            });
            expect({ type: own.type.name, caretInLastLine: selection.$head.parent === lastLine }, `taken: ${where}`).toEqual({ type, caretInLastLine: true });
          } else {
            expect({ type: own.type.name, size: own.content.size, caretHere: selection.$head.parent === own }, `kept: ${where}`).toEqual({ type: 'paragraph', size: 0, caretHere: true });
          }
          unmountAll();
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** Body lines whose words are one letter each, so a line that takes another's words shows. */
const letteredBody = fc.array(
  fc.oneof(
    fc.constant('paragraph'),
    fc.constant('heading'),
    fc.constant('bulletListItem'),
    fc.constant('quoted'),
    fc.constant('nested'),
    fc.constant('image'),
    fc.constant('table'),
  ),
  { minLength: 2, maxLength: 5 },
).filter((kinds) => kinds.some((kind) => kind !== 'image')).map((kinds) => kinds.map((kind, i): BodyBlock => {
  const a = 'abcdefghijklm'[i * 2]!.repeat(3);
  const b = 'abcdefghijklm'[i * 2 + 1]!.repeat(3);
  switch (kind) {
    case 'image': return { type: 'image', props: { url: `${OURS}old${i}.png` } };
    case 'table': return tableBlock({ rows: [{ cells: [a, b] }] });
    case 'quoted': return { type: 'paragraph', content: a, props: { quoted: true } };
    case 'nested': return { type: 'paragraph', content: a, children: [{ type: 'paragraph', content: b }] };
    default: return { type: kind, content: a };
  }
}));

/**
 * Each line's reader letters.
 * @param doc - The document.
 * @returns One string per line that holds any.
 */
function readerLines(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      const letters = node.textContent.match(READER)?.join('') ?? '';
      if (letters !== '') out.push(letters);
    }
    return true;
  });
  return out;
}

describe('a drop, then deleting what it selected (design §5.4.1)', () => {
  it('keeps every line the reader wrote, its words and its own line', () => {
    fc.assert(
      fc.property(
        fc.record({ body: letteredBody, pieces: fc.array(piece, { minLength: 1, maxLength: 4 }), at: fc.nat(), source: fc.constantFrom<Source>('web', 'own') }),
        ({ body: blocks, pieces, at, source }) => {
          const { editor } = open(blocks as never);
          const view = editor.prosemirrorView;
          const points = textPositions(view.state.doc);
          const point = points[at % points.length]!;
          const $point = view.state.doc.resolve(point);
          let inCell = false;
          for (let d = $point.depth; d > 0; d -= 1) if ($point.node(d).type.name === 'docTableCell') inCell = true;
          // A table dropped in a cell fills or is refused (§5.4.7), not a drop of lines.
          if (inCell && pieces.some((p) => p.kind === 'table')) {
            unmountAll();
            return;
          }
          const letters = (doc: PMNode): string => [...(doc.textContent.match(READER) ?? [])].sort().join('');
          const before = letters(view.state.doc);
          const html = editor.blocksToFullHTML(blocksOf(pieces) as never);
          const formats: Record<string, string> = source === 'own' ? { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' } : { 'text/html': html, 'text/plain': 'copied' };
          const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
          for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
          view.posAtCoords = (): { pos: number; inside: number } => ({ pos: point, inside: -1 });
          const event = new Event('drop', { bubbles: true, cancelable: true });
          Object.assign(event, { clientX: 1, clientY: 1 });
          Object.defineProperty(event, 'dataTransfer', { value: { types: Object.keys(formats), files: [], items: [], getData: (type: string): string => formats[type] ?? '' } });
          const linesBefore = readerLines(view.state.doc);
          view.dom.dispatchEvent(event);
          // One block alone is selected whole (ProseMirror's own drop), and
          // deleting it leaves a line it split in two.
          const whole = view.state.selection instanceof NodeSelection;
          view.dispatch(view.state.tr.deleteSelection());
          const where = `${source} ${JSON.stringify(blocks)} ${JSON.stringify(pieces)} @${point} → ${shape(editor)}`;
          expect(letters(view.state.doc), `words: ${where}`).toBe(before);
          if (whole) for (const line of readerLines(view.state.doc)) expect(new Set(line).size, `lines: ${where}`).toBe(1);
          else expect(readerLines(view.state.doc), `lines: ${where}`).toEqual(linesBefore);
          unmountAll();
        },
      ),
      { numRuns: 300 },
    );
  });
});
