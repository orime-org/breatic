// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec section 11: the delete executor on the document
 * body (design 5.3 steps 2 to 8). While the Space is full the filter refuses
 * the editor's own delete and the executor deletes the same range straight
 * from Yjs, so the update holds only a delete set.
 *
 * Each accepted case follows the spec's executor template X: one local
 * update of the listed shape; the editor's blocks as listed and equal to
 * what Yjs renders; the text outside the range kept; no toast; one undo
 * once the Space is back to warning brings the blocks back; the caret at the
 * range's start. The body is the production one (`getDocumentEditor`), its
 * content loaded as a remote update (spec 0.1).
 *
 * X-30 and X-31 cannot be reached from a real editor and feed the
 * executor's planning function directly (spec answer Q7). Its name and
 * signature are this file's choice, for the implementation to adopt:
 * `planSpaceDelete(tr, binding, { syncKey, overCeiling })` returns
 * `{ ok: true, kind: 'delete' | 'remove', ... }` or
 * `{ ok: false, refusal: 'add' | 'compound' | 'over_ceiling' }`, where
 * `refusal` names the toast the filter then shows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, type Transaction } from '@tiptap/pm/state';
import type * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { changeLocale } from '@web/i18n/locale-bootstrap';
import type * as Executor from '@web/features/collab-editor/space-delete-executor';
import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';
import { deleteRow } from '@web/spaces/document/document-handle-commands';
import { clearDocument } from '@web/spaces/document/document-select-all-guard';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import {
  COPY,
  DOCUMENT_NAME,
  capture,
  clearToasts,
  enterState,
  expectBodyInStep,
  expectCaretNear,
  expectUntouched,
  expectWarnings,
  flush,
  nodesOf,
  openBody,
  posOf,
  press,
  remoteBodyParagraph,
  resetHarness,
  rows,
  select,
  type BlockInput,
  type Capture,
  type OpenBody,
  type Row,
  type SizeCode,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

/**
 * A paragraph block.
 * @param text - Its text, or none.
 * @param children - Nested blocks.
 * @returns The block input.
 */
function p(text = '', children?: BlockInput[]): BlockInput {
  return { type: 'paragraph', ...(text !== '' && { content: text }), ...(children !== undefined && { children }) };
}

/**
 * A bullet list item block.
 * @param text - Its text.
 * @param children - Nested items.
 * @returns The block input.
 */
function li(text: string, children?: BlockInput[]): BlockInput {
  return { type: 'bulletListItem', content: text, ...(children !== undefined && { children }) };
}

const IMAGE: BlockInput = { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a' } };
const IMAGE_2: BlockInput = { type: 'image', props: { url: 'https://cdn.example/b.png', name: 'b' } };

/**
 * Selects from one needle's offset to another's and presses Backspace.
 * @param body - The open body.
 * @param from - Start needle and offset into it.
 * @param to - End needle and offset into it.
 * @returns The selection's start.
 */
function deleteBetween(body: OpenBody, from: [string, number], to: [string, number]): number {
  const a = posOf(body.view.state.doc, from[0], from[1]);
  const b = posOf(body.view.state.doc, to[0], to[1]);
  select(body.view, a, b);
  press(body.view, 'Backspace');
  return a;
}

/**
 * Selects the whole document and deletes it the way the body does: Mod-a
 * widens to the whole document on its second tier, Backspace then asks the
 * Space to confirm (`onClearDocumentRequest`), and the confirmation runs
 * `clearDocument`.
 * @param body - The open body.
 * @returns The start of the document's content.
 */
function selectAllAndDelete(body: OpenBody): number {
  for (let tier = 0; tier < 3 && !(body.view.state.selection instanceof AllSelection); tier += 1) {
    press(body.view, 'a', { mod: true });
  }
  expect(body.view.state.selection).toBeInstanceOf(AllSelection);
  let asked = false;
  const stop = body.handle.onClearDocumentRequest(() => {
    asked = true;
  });
  press(body.view, 'Backspace');
  stop();
  expect(asked).toBe(true);
  clearDocument(body.editor);
  return 1;
}

/**
 * Deletes a top-level block from its side menu.
 * @param body - The open body.
 * @param index - The block's index.
 * @returns The position before the block.
 */
function sideMenuDelete(body: OpenBody, index: number): number {
  const id = body.editor.document[index].id;
  const at = nodesOf(body.view.state.doc, 'blockContainer').find((pos) => body.view.state.doc.nodeAt(pos)!.attrs['id'] === id)!;
  deleteRow(body.editor, id);
  return at;
}

/** One case of the executor template, from the spec's section 11 table. */
interface Accepted {
  readonly id: string;
  readonly title: string;
  readonly blocks: BlockInput[];
  /** Runs the operation; returns the range's start in the document before it. */
  readonly op: (body: OpenBody) => number;
  readonly result: Row[];
  readonly shape: 'D' | 'R';
  /** Text outside the range that must still be there. */
  readonly outside: string[];
  /** The case is accepted over the ceiling too (shape R). */
  readonly overCeiling?: boolean;
}

/**
 * Opens the body, enters the state, captures, runs the operation and flushes the executor.
 * @param blocks - Initial blocks.
 * @param code - The size state.
 * @param op - The operation.
 * @returns The body, the capture, the rows before and the range start.
 */
async function run(
  blocks: BlockInput[],
  code: SizeCode,
  op: (body: OpenBody) => number,
): Promise<{ body: OpenBody; cap: Capture; before: Row[]; start: number }> {
  const body = openBody(blocks);
  const before = rows(body.view.state.doc);
  enterState(DOCUMENT_NAME, code);
  const cap = capture(body.doc);
  const start = op(body);
  await flush();
  return { body, cap, before, start };
}

/**
 * Template X items 1 to 4 and 6.
 * @param ran - What {@link run} returned.
 * @param ran.body - The open body.
 * @param ran.cap - The capture.
 * @param ran.start - The range start.
 * @param expected - The case.
 */
function expectAccepted(
  { body, cap, start }: { body: OpenBody; cap: Capture; start: number },
  expected: Pick<Accepted, 'result' | 'shape' | 'outside'>,
): void {
  expect(cap.updates).toHaveLength(1);
  expect(cap.shape()).toBe(expected.shape);
  expect(rows(body.view.state.doc)).toEqual(expected.result);
  expectBodyInStep(body);
  const text = body.view.state.doc.textContent;
  for (const kept of expected.outside) expect(text).toContain(kept);
  expectWarnings();
  expectCaretNear(body.view, start);
}

/**
 * Template X item 5: back to warning, one body undo restores the blocks.
 * @param body - The open body.
 * @param before - The rows before the operation.
 */
async function expectUndoRestores(body: OpenBody, before: Row[]): Promise<void> {
  enterState(DOCUMENT_NAME, 'W');
  body.editor.undo();
  await flush();
  expect(rows(body.view.state.doc)).toEqual(before);
  expectBodyInStep(body);
}

const ACCEPTED: readonly Accepted[] = [
  {
    id: 'X-01', title: 'deleting text inside a paragraph', blocks: [p('Hello world')],
    op: (body) => deleteBetween(body, ['Hello', 2], ['Hello', 5]),
    result: [['paragraph', 'He world']], shape: 'D', outside: ['He', ' world'],
  },
  {
    id: 'X-03', title: 'the side menu deleting the middle block', blocks: [p('a'), p('b'), p('c')],
    op: (body) => sideMenuDelete(body, 1),
    result: [['paragraph', 'a'], ['paragraph', 'c']], shape: 'R', outside: ['a', 'c'], overCeiling: true,
  },
  {
    id: 'X-04', title: 'the side menu deleting a block with a child', blocks: [p('a'), p('b', [p('b1')]), p('c')],
    op: (body) => sideMenuDelete(body, 1),
    result: [['paragraph', 'a'], ['paragraph', 'c']], shape: 'R', outside: ['a', 'c'], overCeiling: true,
  },
  {
    id: 'X-07', title: 'a cross-block selection with text left on both sides keeps the two blocks', blocks: [p('Hello'), p('World')],
    op: (body) => deleteBetween(body, ['Hello', 2], ['World', 2]),
    result: [['paragraph', 'He'], ['paragraph', 'rld']], shape: 'D', outside: ['He', 'rld'],
  },
  {
    id: 'X-08', title: 'selecting all of a block\'s text deletes its XmlText', blocks: [p('Hello'), p('World')],
    op: (body) => deleteBetween(body, ['World', 0], ['World', 5]),
    result: [['paragraph', 'Hello'], ['paragraph', '']], shape: 'R', outside: ['Hello'], overCeiling: true,
  },
  {
    id: 'X-09', title: 'a cross-block selection emptying the end side deletes the end block', blocks: [p('Hello'), p('World')],
    op: (body) => deleteBetween(body, ['Hello', 2], ['World', 5]),
    result: [['paragraph', 'He']], shape: 'D', outside: ['He'],
  },
  {
    id: 'X-10', title: 'a cross-block selection emptying the start side deletes the start block', blocks: [p('Hello'), p('World')],
    op: (body) => deleteBetween(body, ['Hello', 0], ['World', 2]),
    result: [['paragraph', 'rld']], shape: 'D', outside: ['rld'],
  },
  {
    id: 'X-14', title: 'from a parent block into its child (ReplaceAroundStep)', blocks: [p('abc', [p('def')])],
    op: (body) => deleteBetween(body, ['abc', 1], ['def', 2]),
    result: [['paragraph', 'a', [['paragraph', 'f']]]], shape: 'D', outside: ['a', 'f'],
  },
  {
    id: 'X-16', title: 'from a child block to the next outer block', blocks: [p('x', [p('child')]), p('outer')],
    op: (body) => deleteBetween(body, ['child', 3], ['outer', 2]),
    result: [['paragraph', 'x', [['paragraph', 'chi']]], ['paragraph', 'ter']], shape: 'D', outside: ['x', 'chi', 'ter'],
  },
  {
    id: 'X-17', title: 'a cross-block delete whose end block has a child keeps the child', blocks: [p('ab'), p('cd', [p('fgh')])],
    op: (body) => deleteBetween(body, ['ab', 1], ['cd', 2]),
    result: [['paragraph', 'a'], ['paragraph', '', [['paragraph', 'fgh']]]], shape: 'D', outside: ['a', 'fgh'],
  },
  {
    id: 'X-20', title: 'deleting text in a code block', blocks: [{ type: 'codeBlock', content: 'const x' }],
    op: (body) => deleteBetween(body, ['const x', 3], ['const x', 5]),
    result: [['codeBlock', 'con x']], shape: 'D', outside: ['con', ' x'],
  },
  {
    id: 'X-21', title: 'selecting all of [image, p x] keeps the first text block, emptied', blocks: [IMAGE, p('x')],
    op: selectAllAndDelete,
    result: [['paragraph', '']], shape: 'R', outside: [],
  },
  {
    id: 'X-21', title: 'the side menu deleting the image of [image, p x]', blocks: [IMAGE, p('x')],
    op: (body) => sideMenuDelete(body, 0),
    result: [['paragraph', 'x']], shape: 'R', outside: ['x'],
  },
  {
    id: 'X-22', title: 'selecting all of [image, image] keeps the first image as it is', blocks: [IMAGE, IMAGE_2],
    op: selectAllAndDelete,
    result: [['image', '']], shape: 'R', outside: [],
  },
  {
    id: 'X-23', title: 'selecting all of [image, table] keeps the image', blocks: [IMAGE, tableBlock({ rows: [{ cells: ['v'] }] })],
    op: selectAllAndDelete,
    result: [['image', '']], shape: 'R', outside: [],
  },
];

beforeEach(() => {
  changeLocale('en');
  clearToasts();
});

afterEach(() => {
  resetHarness();
});

describe('11. the delete executor on the document body, accepted cases', () => {
  it.each(ACCEPTED.map((entry) => [`${entry.id}: in F, ${entry.title}`, entry] as const))('%s', async (_title, entry) => {
    const ran = await run(entry.blocks, 'F', entry.op);
    expectAccepted(ran, entry);
    await expectUndoRestores(ran.body, ran.before);
  });

  it('X-02: a second delete in the same paragraph is accepted too', async () => {
    const ran = await run([p('Hello world')], 'F', (body) => deleteBetween(body, ['Hello', 2], ['Hello', 5]));
    expectAccepted(ran, { result: [['paragraph', 'He world']], shape: 'D', outside: ['He', ' world'] });
    const second = capture(ran.body.doc);
    const start = deleteBetween(ran.body, ['He world', 1], ['He world', 3]);
    await flush();
    expectAccepted({ body: ran.body, cap: second, start }, { result: [['paragraph', 'Hworld']], shape: 'D', outside: ['H', 'world'] });
  });

  it.each(['F', 'O'] as const)('X-05: in %s, the side menu deleting the only block empties it and keeps its id', async (code) => {
    const ran = await run([p('only')], code, (body) => sideMenuDelete(body, 0));
    expectAccepted(ran, { result: [['paragraph', '']], shape: 'R', outside: [] });
    expect(ran.body.editor.document[0].id).toBe(ran.body.ids[0]);
    await expectUndoRestores(ran.body, ran.before);
  });

  it.each((['F', 'O'] as const).flatMap((code) => [
    { code, how: 'Mod-a then Backspace', op: selectAllAndDelete },
    { code, how: 'removeBlocks on every block', op: (body: OpenBody) => { body.editor.removeBlocks(body.editor.document.map((block) => block.id)); return 1; } },
  ]))('X-06: in $code, $how keeps the first block, emptied, with its id', async ({ code, op }) => {
    const ran = await run([p('one'), p('two'), p('three')], code, op);
    expectAccepted(ran, { result: [['paragraph', '']], shape: 'R', outside: [] });
    expect(ran.body.editor.document[0].id).toBe(ran.body.ids[0]);
    await expectUndoRestores(ran.body, ran.before);
  });

  it('X-11: deleting across a bold run keeps the marks on what is left', async () => {
    const blocks: BlockInput[] = [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'plain ', styles: {} },
        { type: 'text', text: 'bold', styles: { bold: true } },
        { type: 'text', text: ' tail', styles: {} },
      ],
    }];
    const ran = await run(blocks, 'F', (body) => deleteBetween(body, ['plain ', 3], ['bold', 2]));
    expectAccepted(ran, { result: [['paragraph', 'plald tail']], shape: 'D', outside: ['pla', 'ld', ' tail'] });
    const doc = ran.body.view.state.doc;
    expect(doc.resolve(posOf(doc, 'ld') + 1).marks().map((mark) => mark.type.name)).toContain('bold');
    expect(doc.resolve(posOf(doc, 'pla') + 1).marks()).toHaveLength(0);
    await expectUndoRestores(ran.body, ran.before);
  });

  /**
   * Opens `ab<hardBreak>cd` and deletes the hard break with a node selection.
   * @returns The run.
   */
  async function deleteHardBreak(): ReturnType<typeof run> {
    return run([p('ab\ncd')], 'F', (body) => {
      const at = nodesOf(body.view.state.doc, 'hardBreak');
      expect(at).toHaveLength(1);
      body.view.dispatch(body.view.state.tr.setSelection(NodeSelection.create(body.view.state.doc, at[0])));
      press(body.view, 'Backspace');
      return at[0];
    });
  }

  it('X-12: deleting a hard break removes its element (R)', async () => {
    const ran = await deleteHardBreak();
    expectAccepted(ran, { result: [['paragraph', 'abcd']], shape: 'R', outside: ['ab', 'cd'] });
    expect(nodesOf(ran.body.view.state.doc, 'hardBreak')).toHaveLength(0);
    await expectUndoRestores(ran.body, ran.before);
  });

  it('X-13: after X-12, a delete across the old seam walks the neighbouring XmlTexts (D)', async () => {
    const { body } = await deleteHardBreak();
    const cap = capture(body.doc);
    const start = posOf(body.view.state.doc, 'abcd', 1);
    select(body.view, start, start + 2);
    press(body.view, 'Backspace');
    await flush();
    expectAccepted({ body, cap, start }, { result: [['paragraph', 'ad']], shape: 'D', outside: ['a', 'd'] });
  });

  it('X-13: after X-12, selecting all of the paragraph\'s text deletes both XmlTexts (R)', async () => {
    const { body } = await deleteHardBreak();
    const cap = capture(body.doc);
    const start = posOf(body.view.state.doc, 'abcd');
    select(body.view, start, start + 4);
    press(body.view, 'Backspace');
    await flush();
    expectAccepted({ body, cap, start }, { result: [['paragraph', '']], shape: 'R', outside: [] });
  });

  it('X-15: from a list item into the next item\'s child: the text outside stays, one pure delete, a valid document', async () => {
    // Spec answer Q15: the executor may merge less and leave empty blocks, so
    // the invariants are asserted, not one block structure.
    const ran = await run([li('one'), li('two', [li('two-a')])], 'F', (body) => deleteBetween(body, ['one', 1], ['two-a', 4]));
    const { body, cap } = ran;
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(body.view.state.doc.textContent).toBe('oa');
    expect(() => { body.view.state.doc.check(); }).not.toThrow();
    expectBodyInStep(body);
    expectWarnings();
    await expectUndoRestores(body, ran.before);
  });

  it('X-18: from the start of one to the start of a child block: the child keeps its text, nothing is redrawn away', async () => {
    const ran = await run([p('one'), p('two', [p('three')])], 'F', (body) => deleteBetween(body, ['one', 0], ['three', 0]));
    const { body, cap } = ran;
    expect(cap.updates).toHaveLength(1);
    // `one` and `two` are each a whole XmlText (step 3), and the block `one` goes whole (step 4): R.
    expect(cap.shape()).toBe('R');
    expect(body.view.state.doc.textContent).toBe('three');
    expect(() => { body.view.state.doc.check(); }).not.toThrow();
    expectBodyInStep(body);
    expectWarnings();
    await expectUndoRestores(body, ran.before);
  });

  /**
   * The texts of every table cell, in order.
   * @param doc - The body.
   * @returns One string per cell.
   */
  function cellTexts(doc: PMNode): string[] {
    return nodesOf(doc, 'docTableCell').map((pos) => doc.nodeAt(pos)!.textContent);
  }

  it('X-19: deleting text inside a table cell', async () => {
    const ran = await run([tableBlock({ rows: [{ cells: ['abc', 'def'] }] })], 'F', (body) => deleteBetween(body, ['abc', 1], ['abc', 2]));
    const { body, cap } = ran;
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(cellTexts(body.view.state.doc)).toEqual(['ac', 'def']);
    expectBodyInStep(body);
    expectWarnings();
    expectCaretNear(body.view, ran.start);
    enterState(DOCUMENT_NAME, 'W');
    body.editor.undo();
    await flush();
    expect(cellTexts(body.view.state.doc)).toEqual(['abc', 'def']);
  });

  it('X-24: selecting all of a lone 2x2 table leaves one row, one cell, one empty paragraph', async () => {
    const ran = await run([tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })], 'F', selectAllAndDelete);
    const { body, cap } = ran;
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('R');
    const doc = body.view.state.doc;
    expect(nodesOf(doc, 'docTable')).toHaveLength(1);
    expect(nodesOf(doc, 'docTableRow')).toHaveLength(1);
    expect(cellTexts(doc)).toEqual(['']);
    const cell = doc.nodeAt(nodesOf(doc, 'docTableCell')[0])!;
    expect(nodesOf(cell, 'paragraph')).toHaveLength(1);
    expectBodyInStep(body);
    expectWarnings();
    enterState(DOCUMENT_NAME, 'W');
    body.editor.undo();
    await flush();
    expect(cellTexts(body.view.state.doc)).toEqual(['a', 'b', 'c', 'd']);
  });

  it.each([
    { id: 'X-03', blocks: [p('a'), p('b'), p('c')], op: (body: OpenBody) => sideMenuDelete(body, 1), result: [['paragraph', 'a'], ['paragraph', 'c']] as Row[], outside: ['a', 'c'] },
    { id: 'X-04', blocks: [p('a'), p('b', [p('b1')]), p('c')], op: (body: OpenBody) => sideMenuDelete(body, 1), result: [['paragraph', 'a'], ['paragraph', 'c']] as Row[], outside: ['a', 'c'] },
    { id: 'X-08', blocks: [p('Hello'), p('World')], op: (body: OpenBody) => deleteBetween(body, ['World', 0], ['World', 5]), result: [['paragraph', 'Hello'], ['paragraph', '']] as Row[], outside: ['Hello'] },
  ])('X-27: in O, $id deletes whole types only and is accepted (R)', async ({ blocks, op, result, outside }) => {
    const ran = await run(blocks, 'O', op);
    expectAccepted(ran, { result, shape: 'R', outside });
    await expectUndoRestores(ran.body, ran.before);
  });
});

describe('11. the delete executor on the document body, refused and abandoned cases', () => {
  it.each([
    { how: 'Mod-a then Backspace', op: selectAllAndDelete },
    { how: 'the side menu delete', op: (body: OpenBody) => sideMenuDelete(body, 0) },
  ])('X-25: [image] alone, $how is refused with the compound toast and the image stays (Q6)', async ({ op }) => {
    const { body, cap } = await run([IMAGE], 'F', op);
    expect(rows(body.view.state.doc)).toEqual([['image', '']]);
    expectUntouched(body.doc, cap);
    expectBodyInStep(body);
    expectWarnings(COPY.T_COMPOUND);
  });

  it('X-26: in O, deleting part of a paragraph\'s text is refused with the over-ceiling toast', async () => {
    const { body, cap } = await run([p('Hello world')], 'O', (b) => deleteBetween(b, ['Hello', 2], ['Hello', 5]));
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'Hello world']]);
    expectUntouched(body.doc, cap);
    expectWarnings(COPY.T_OVER);
  });

  it('X-28: a peer\'s update arriving before the executor\'s microtask makes it give up', async () => {
    const body = openBody([p('Hello world')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    deleteBetween(body, ['Hello', 2], ['Hello', 5]);
    // Synchronously, before the microtask the executor runs in.
    remoteBodyParagraph(body.doc, 'peer');
    await flush();
    expect(cap.shape()).toBe('∅');
    expect(cap.updates).toHaveLength(0);
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'Hello world'], ['paragraph', 'peer']]);
    expectBodyInStep(body);
  });

  it.each([
    {
      last: 'a comment mark on Hello',
      write: (body: OpenBody) => {
        const from = posOf(body.view.state.doc, 'Hello');
        const mark = body.view.state.schema.marks[COMMENT_MARK].create({ threadId: 'thread-1', orphan: false });
        body.view.dispatch(body.view.state.tr.addMark(from, from + 5, mark));
      },
    },
    {
      last: 'a column width written with addToHistory false',
      write: (body: OpenBody) => {
        const cell = nodesOf(body.view.state.doc, 'docTableCell')[0];
        body.view.dispatch(body.view.state.tr.setNodeAttribute(cell, 'colwidth', [240]).setMeta('addToHistory', false));
      },
    },
  ])('X-29: when the last local write before full was $last, the executor\'s delete still goes on the undo stack', async ({ write }) => {
    const body = openBody([p('Hello world'), tableBlock({ rows: [{ cells: ['v'] }] })]);
    enterState(DOCUMENT_NAME, 'N');
    write(body);
    await flush();
    enterState(DOCUMENT_NAME, 'F');
    const depth = body.handle.undoManager.undoStack.length;
    deleteBetween(body, ['Hello', 2], ['Hello', 5]);
    await flush();
    expect(rows(body.view.state.doc)[0]).toEqual(['paragraph', 'He world']);
    expect(body.handle.undoManager.undoStack.length).toBe(depth + 1);
    enterState(DOCUMENT_NAME, 'W');
    body.editor.undo();
    await flush();
    expect(rows(body.view.state.doc)[0]).toEqual(['paragraph', 'Hello world']);
  });
});

/**
 * The executor module, loaded when a case needs it so the rest of this file
 * runs before the module exists.
 * @returns The module.
 */
async function loadExecutor(): Promise<typeof Executor> {
  // A variable specifier: vite resolves a literal one while transforming the
  // file and would fail the whole file before the module exists.
  const specifier = '@web/features/collab-editor/space-delete-executor';
  return import(/* @vite-ignore */ specifier) as Promise<typeof Executor>;
}

describe('11. the planning function fed directly', () => {
  /**
   * The body's sync binding.
   * @param body - The open body.
   * @returns The binding y-prosemirror keeps in its plugin state.
   */
  function bindingOf(body: OpenBody): { mapping: Map<Y.AbstractType<unknown>, unknown>; type: Y.XmlFragment; doc: Y.Doc } {
    return (body.syncKey.getState(body.view.state) as { binding: { mapping: Map<Y.AbstractType<unknown>, unknown>; type: Y.XmlFragment; doc: Y.Doc } }).binding;
  }

  it('X-30: a result that deletes more than ProseMirror\'s own transaction is refused with the compound toast\'s reason', async () => {
    const { planSpaceDelete } = await loadExecutor();
    // No transaction a real editor builds makes the executor delete more than
    // ProseMirror does, so the comparison is fed a transaction whose own
    // result keeps the hard break the range covers.
    const body = openBody([p('ab\ncd')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    const state = body.view.state;
    const at = nodesOf(state.doc, 'hardBreak')[0];
    const tr = state.tr.delete(at - 1, at + 2);
    const keepsBreak = state.tr.delete(at - 1, at).delete(at, at + 1).doc;
    expect(nodesOf(keepsBreak, 'hardBreak')).toHaveLength(1);
    const fed = Object.create(tr, { doc: { get: () => keepsBreak } }) as Transaction;
    const plan = planSpaceDelete(fed, bindingOf(body), { syncKey: body.syncKey, overCeiling: false });
    expect(plan).toEqual({ ok: false, refusal: 'compound' });
    expectUntouched(body.doc, cap);
    expectWarnings();
  });

  it('X-31: a range the binding cannot locate is refused with the add toast\'s reason and writes nothing', async () => {
    const { planSpaceDelete } = await loadExecutor();
    const body = openBody([p('Hello world')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    const from = posOf(body.view.state.doc, 'Hello', 2);
    const tr = body.view.state.tr.delete(from, from + 3);
    const real = bindingOf(body);
    const unmapped = Object.create(real, { mapping: { value: new Map() } }) as typeof real;
    const plan = planSpaceDelete(tr, unmapped, { syncKey: body.syncKey, overCeiling: false });
    expect(plan).toEqual({ ok: false, refusal: 'add' });
    // The same transaction with the real binding is one the executor takes.
    expect(planSpaceDelete(tr, real, { syncKey: body.syncKey, overCeiling: false })).toMatchObject({ ok: true, kind: 'delete' });
    expectUntouched(body.doc, cap);
    expectWarnings();
  });
});
