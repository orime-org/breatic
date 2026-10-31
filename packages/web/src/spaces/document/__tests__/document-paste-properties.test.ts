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

/** A piece of pasted content. */
type Piece = { kind: 'words'; words: string } | { kind: 'medium' } | { kind: 'table'; words: string } | { kind: 'divider' };

const piece: fc.Arbitrary<Piece> = fc.oneof(
  pastedWords.map((words): Piece => ({ kind: 'words', words })),
  fc.constant<Piece>({ kind: 'medium' }),
  pastedWords.map((words): Piece => ({ kind: 'table', words })),
  fc.constant<Piece>({ kind: 'divider' }),
);

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
  const blocks = pieces.map((p) =>
    p.kind === 'medium'
      ? { type: 'image', props: { url: media() } }
      : p.kind === 'table'
        ? tableBlock({ rows: [{ cells: [p.words] }] })
        : p.kind === 'divider'
          ? { type: 'divider' }
          : { type: 'paragraph', content: p.words },
  );
  const html = editor.blocksToFullHTML(blocks as never);
  pasteFormats(editor, source === 'own' ? { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' } : { 'text/html': html, 'text/plain': 'copied' });
}

/**
 * Every block container's id, depth and first child.
 * @param doc - The document.
 * @returns They.
 */
function containers(doc: PMNode): { id: string; depth: number; node: PMNode }[] {
  const out: { id: string; depth: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer' || node.type.name === 'docTable') out.push({ id: String(node.attrs['id']), depth: doc.resolve(pos).depth, node });
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
  pieces: fc.array(piece, { minLength: 1, maxLength: 4 }).filter((p) => p.some((x) => x.kind !== 'words')),
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
  if (!content.some((p) => p.kind !== 'words')) return;
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

  const media = placed.filter((c) => ['image', 'docTable', 'divider'].includes(c.node.type.name === 'docTable' ? c.node.type.name : c.node.firstChild!.type.name));
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
  const pasted = content.filter((p) => p.kind === 'medium').length * copies;
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
          let html = '';
          let own = '';
          {
            let n = 0;
            const blocks = pieces.map((p) =>
              p.kind === 'medium'
                ? { type: 'image', props: { url: `${OURS}m${n++}.png` } }
                : p.kind === 'table'
                  ? tableBlock({ rows: [{ cells: [p.words] }] })
                  : p.kind === 'divider'
                    ? { type: 'divider' }
                    : { type: 'paragraph', content: p.words },
            );
            html = dropped.blocksToFullHTML(blocks as never);
            own = source === 'own' ? html : '';
          }
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
