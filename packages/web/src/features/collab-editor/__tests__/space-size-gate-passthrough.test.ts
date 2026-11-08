// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 21.3 (round 6): while full, a deletion of text
 * that stays inside one `XmlText`, in a text block whose element holds only
 * that `XmlText`, is let through to y-prosemirror (design 5.3 line 217); over
 * the ceiling, deleting part of one `XmlText` is refused before any planning
 * (lines 218, 231). A range holding an inline node, or a block with two
 * neighbouring `XmlText`s, still goes to the executor.
 *
 * The body is the production one, its content loaded as a remote update: the
 * paragraph `P6` carries bold, italic, a link and a comment mark (thread t1),
 * all marks, so the paragraph is one `XmlText`. The executor module is wrapped
 * by a pass-through spy that counts plans.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

vi.mock('@web/features/collab-editor/space-delete-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof Executor>();
  return { ...actual, planSpaceDelete: vi.fn(actual.planSpaceDelete) };
});
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import type * as Executor from '@web/features/collab-editor/space-delete-executor';
import { planSpaceDelete } from '@web/features/collab-editor/space-delete-executor';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { COMMENT_MARK, asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import {
  CANVAS_NAME,
  COPY,
  DOCUMENT_NAME,
  backspaceChar,
  capture,
  clearToasts,
  deleteBetween,
  enterState,
  expectBodyInStep,
  expectNoTextMappings,
  expectTiptapInStep,
  expectUntouched,
  expectWarnings,
  flush,
  mountBody,
  nodesOf,
  openBody,
  openTiptap,
  paragraphTexts,
  paragraphs,
  pBlock as p,
  posOf,
  press,
  resetHarness,
  rows,
  select,
  topBlockIds,
  type BlockInput,
  type OpenBody,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

const LINK = 'https://example.test';

/** The paragraph `P6` of spec 21.3, as BlockNote inline content. */
const P6: BlockInput = {
  type: 'paragraph',
  content: [
    { type: 'text', text: 'plain text ', styles: {} },
    { type: 'text', text: 'boldword', styles: { bold: true } },
    { type: 'text', text: ' middle ', styles: {} },
    { type: 'text', text: 'italword', styles: { italic: true } },
    { type: 'link', href: LINK, content: 'linkword' },
    { type: 'text', text: ' tail commented end', styles: {} },
  ],
};

/** `P6` as plain text; offsets below index into it. */
const P6_TEXT = 'plain text boldword middle italwordlinkword tail commented end';

/**
 * The offset of a needle in `P6_TEXT`, plus characters into it.
 * @param needle - Text.
 * @param into - Characters into the needle.
 * @returns The offset.
 */
function at(needle: string, into = 0): number {
  const found = P6_TEXT.indexOf(needle);
  expect(found).toBeGreaterThanOrEqual(0);
  return found + into;
}

/** The open body with `P6` and the thread its comment mark points at. */
interface P6Body {
  readonly body: OpenBody;
  readonly threadId: string;
}

/**
 * Opens the body with `P6`, loaded as a remote update: thread t1 is created
 * first (a thread the store owns), then a peer writes the paragraph and marks
 * `commented` with t1.
 * @returns The open body and t1's id.
 */
async function openP6(): Promise<P6Body> {
  const mounted = mountBody();
  const store = commentsOn(mounted.editor)!.threadStore as unknown as {
    createThread: (options: { initialComment: { body: never } }) => Promise<{ id: string }>;
  };
  const thread = await store.createThread({ initialComment: { body: asCommentBody('t1') as never } });
  const source = new Y.Doc();
  Y.applyUpdate(source, Y.encodeStateAsUpdate(mounted.doc));
  const peer = buildDocumentEditor({ fragment: documentBodyFragment(source) });
  peer.mount(document.createElement('div'));
  peer.replaceBlocks(peer.document, [P6] as never);
  const peerView = peer.prosemirrorView;
  const from = posOf(peerView.state.doc, 'commented');
  const mark = peerView.state.schema.marks[COMMENT_MARK].create({ threadId: thread.id, orphan: false });
  peerView.dispatch(peerView.state.tr.addMark(from, from + 'commented'.length, mark));
  Y.applyUpdate(mounted.doc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(mounted.doc)), 'remote');
  peer.unmount();
  source.destroy();
  mounted.view.dom.focus();
  expectNoTextMappings(mounted.view, mounted.syncKey);
  const body = { ...mounted, ids: topBlockIds(mounted.editor) };
  expect(body.view.state.doc.textContent).toBe(P6_TEXT);
  return { body, threadId: thread.id };
}

/**
 * Each character of the first paragraph with the marks it carries, as text.
 * @param doc - The body.
 * @returns One entry per character: the character and its sorted marks with their attributes.
 */
function charMarks(doc: PMNode): string[] {
  const out: string[] = [];
  const paragraph = doc.nodeAt(nodesOf(doc, 'paragraph')[0])!;
  paragraph.forEach((child) => {
    const marks = child.marks.map((mark) => `${mark.type.name}${JSON.stringify(mark.attrs)}`).sort().join('|');
    for (const char of child.text ?? '') out.push(`${char}<${marks}>`);
  });
  return out;
}

/**
 * The document position of an offset in the first paragraph's text.
 * @param doc - The body.
 * @param offset - Offset into `P6_TEXT`.
 * @returns The position.
 */
function posAt(doc: PMNode, offset: number): number {
  return posOf(doc, 'plain') + offset;
}

/** How a case deletes `[from, to)` of `P6_TEXT`. */
type How = 'backspace' | 'range' | 'delete';

/**
 * Deletes `[from, to)` of the first paragraph the way the case says.
 * @param view - The view.
 * @param from - Start offset.
 * @param to - End offset.
 * @param how - A Backspace after the character, a selection and Backspace, or Delete before the character.
 */
function deleteOffsets(view: EditorView, from: number, to: number, how: How): void {
  const a = posAt(view.state.doc, from);
  const b = posAt(view.state.doc, to);
  if (how === 'range') {
    select(view, a, b);
    press(view, 'Backspace');
    return;
  }
  if (how === 'backspace') {
    select(view, b);
    backspaceChar(view);
    return;
  }
  select(view, a);
  if (press(view, 'Delete')) return;
  view.dispatch(view.state.tr.delete(a, a + 1));
}

/**
 * Asserts how many times the filter asked the executor to plan.
 * @param times - The expected count.
 */
function expectPlans(times: number): void {
  expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(times);
}

/** One row of the spec 21.3 table on `P6`. */
interface Case {
  readonly id: string;
  readonly what: string;
  readonly from: number;
  readonly to: number;
  readonly how: How;
}

const CASES: readonly Case[] = [
  { id: 'PT-01', what: 'the a of plain', from: at('plain', 2), to: at('plain', 3), how: 'backspace' },
  { id: 'PT-02', what: 'the first character of the bold word', from: at('boldword'), to: at('boldword', 1), how: 'backspace' },
  { id: 'PT-03', what: 'the last character of the bold word', from: at('boldword', 7), to: at('boldword', 8), how: 'backspace' },
  { id: 'PT-04', what: 'the fourth character of the bold word', from: at('boldword', 3), to: at('boldword', 4), how: 'backspace' },
  { id: 'PT-05', what: 'the space right after the bold word', from: at('boldword', 8), to: at('boldword', 9), how: 'backspace' },
  { id: 'PT-06', what: 'the last character of the italic word', from: at('italword', 7), to: at('italword', 8), how: 'backspace' },
  { id: 'PT-07', what: 'the first character of the link', from: at('linkword'), to: at('linkword', 1), how: 'backspace' },
  { id: 'PT-08', what: 'the last character of the link', from: at('linkword', 7), to: at('linkword', 8), how: 'backspace' },
  { id: 'PT-09', what: 'a range plain to bold to plain', from: at('text', 2), to: at('middle', 2), how: 'range' },
  { id: 'PT-10', what: 'a range italic to link to plain', from: at('italword', 2), to: at('tail', 2), how: 'range' },
  { id: 'PT-11', what: 'the first character of the commented word', from: at('commented'), to: at('commented', 1), how: 'backspace' },
  { id: 'PT-11', what: 'the last character of the commented word', from: at('commented', 8), to: at('commented', 9), how: 'backspace' },
  { id: 'PT-11', what: 'a middle character of the commented word', from: at('commented', 2), to: at('commented', 3), how: 'backspace' },
  { id: 'PT-12', what: 'a range from outside the comment mark, through it and out', from: at('tail', 2), to: at('end', 1), how: 'range' },
  { id: 'PT-15', what: 'Delete on the fourth character of the bold word', from: at('boldword', 3), to: at('boldword', 4), how: 'delete' },
];

/** Expected paragraph texts the spec lists, checked against the offsets. */
const EXPECTED_TEXT: Readonly<Record<string, string>> = {
  'PT-01': 'plin text boldword middle italwordlinkword tail commented end',
  'PT-02': 'plain text oldword middle italwordlinkword tail commented end',
  'PT-03': 'plain text boldwor middle italwordlinkword tail commented end',
  'PT-04': 'plain text bolword middle italwordlinkword tail commented end',
  'PT-05': 'plain text boldwordmiddle italwordlinkword tail commented end',
  'PT-06': 'plain text boldword middle italworlinkword tail commented end',
  'PT-07': 'plain text boldword middle italwordinkword tail commented end',
  'PT-08': 'plain text boldword middle italwordlinkwor tail commented end',
  'PT-09': 'plain teddle italwordlinkword tail commented end',
  'PT-10': 'plain text boldword middle itil commented end',
  'PT-12': 'plain text boldword middle italwordlinkword tand',
  'PT-15': 'plain text bolword middle italwordlinkword tail commented end',
};

beforeEach(() => {
  changeLocale('en');
  clearToasts();
  vi.mocked(planSpaceDelete).mockClear();
});

afterEach(() => {
  resetHarness();
});

describe('21.3 a deletion inside one text block is let through while full', () => {
  it.each(CASES.map((entry) => [`${entry.id}: in F, ${entry.what} is let through to y-prosemirror as one pure delete`, entry] as const))(
    '%s',
    async (_title, { id, from, to, how }) => {
      const { body, threadId } = await openP6();
      enterState(DOCUMENT_NAME, 'F');
      const threads = documentCommentThreads(body.doc);
      const threadsBefore = JSON.stringify(threads.toJSON());
      const marksBefore = charMarks(body.view.state.doc);
      const cap = capture(body.doc);
      deleteOffsets(body.view, from, to, how);
      await flush();
      expect(cap.updates).toHaveLength(1);
      expect(cap.shape()).toBe('D');
      expectPlans(0);
      expectWarnings();
      const text = P6_TEXT.slice(0, from) + P6_TEXT.slice(to);
      if (EXPECTED_TEXT[id] !== undefined) expect(text).toBe(EXPECTED_TEXT[id]);
      expect(rows(body.view.state.doc)).toEqual([['paragraph', text]]);
      // What is left keeps its marks: bold, italic, the link's href, the thread id.
      expect(charMarks(body.view.state.doc)).toEqual([...marksBefore.slice(0, from), ...marksBefore.slice(to)]);
      expectBodyInStep(body);
      expect(JSON.stringify(threads.toJSON())).toBe(threadsBefore);
      expect(threads.has(threadId)).toBe(true);
    },
  );

  it('PT-12: deleting every marked character leaves no comment mark and keeps thread t1', async () => {
    const { body, threadId } = await openP6();
    enterState(DOCUMENT_NAME, 'F');
    deleteOffsets(body.view, at('tail', 2), at('end', 1), 'range');
    await flush();
    expect(charMarks(body.view.state.doc).some((entry) => entry.includes(COMMENT_MARK))).toBe(false);
    expect(documentCommentThreads(body.doc).has(threadId)).toBe(true);
    expectPlans(0);
  });

  it('PT-13: a range holding a hard break is not let through: the executor deletes it (R)', async () => {
    const body = openBody([p('ab\ncd')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    const breakAt = nodesOf(body.view.state.doc, 'hardBreak')[0];
    body.view.dispatch(body.view.state.tr.setSelection(NodeSelection.create(body.view.state.doc, breakAt)));
    press(body.view, 'Backspace');
    await flush();
    expectPlans(1);
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('R');
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'abcd']]);
    expectBodyInStep(body);
    expectWarnings();
  });

  it('PT-13: a range o<hard break>w is not let through: the executor deletes it (D)', async () => {
    const body = openBody([p('hello\nworld')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    const breakAt = nodesOf(body.view.state.doc, 'hardBreak')[0];
    select(body.view, breakAt - 1, breakAt + 2);
    press(body.view, 'Backspace');
    await flush();
    expectPlans(1);
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'hellorld']]);
    expectBodyInStep(body);
    expectWarnings();
  });

  it.each([
    { what: 'b', offset: 1, text: 'acd' },
    { what: 'c', offset: 2, text: 'abd' },
  ])('PT-14: after X-12 (two neighbouring XmlTexts), deleting $what goes to the executor as one pure delete (D)', async ({ offset, text }) => {
    const body = openBody([p('ab\ncd')]);
    enterState(DOCUMENT_NAME, 'F');
    const breakAt = nodesOf(body.view.state.doc, 'hardBreak')[0];
    body.view.dispatch(body.view.state.tr.setSelection(NodeSelection.create(body.view.state.doc, breakAt)));
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'abcd']]);
    vi.mocked(planSpaceDelete).mockClear();
    const cap = capture(body.doc);
    const start = posOf(body.view.state.doc, 'abcd', offset);
    select(body.view, start, start + 1);
    press(body.view, 'Backspace');
    await flush();
    expectPlans(1);
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(rows(body.view.state.doc)).toEqual([['paragraph', text]]);
    expectBodyInStep(body);
    expectWarnings();
  });

  it('PT-16: canvas text node body in F, deleting lo is let through to y-tiptap (D)', async () => {
    const open = openTiptap('textBody', paragraphs('hello world'));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    const start = posOf(open.view.state.doc, 'hello', 3);
    select(open.view, start, start + 2);
    press(open.view, 'Backspace');
    await flush();
    expectPlans(0);
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(paragraphTexts(open.view.state.doc)).toEqual(['hel world']);
    expectTiptapInStep(open);
    expectWarnings();
  });

  it('PT-17: a cross-block selection (X-07) still goes to the executor', async () => {
    const body = openBody([p('Hello'), p('World')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    deleteBetween(body, ['Hello', 2], ['World', 2]);
    await flush();
    expectPlans(1);
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'He'], ['paragraph', 'rld']]);
    expectWarnings();
  });

  it('PT-18: typing x over the selected bold word is not let through: add toast, nothing written', async () => {
    const { body } = await openP6();
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    const from = posAt(body.view.state.doc, at('boldword'));
    select(body.view, from, from + 'boldword'.length);
    const { from: a, to: b } = body.view.state.selection;
    const handled = body.view.someProp('handleTextInput', (f) => f(body.view, a, b, 'x', () => body.view.state.tr.insertText('x', a, b)));
    if (handled !== true) body.view.dispatch(body.view.state.tr.insertText('x', a, b));
    await flush();
    expect(body.view.state.doc.textContent).toBe(P6_TEXT);
    expectUntouched(body.doc, cap);
    expectWarnings(COPY.T_ADD);
  });

  it('PT-19: after PT-04, warning and one undo bring the d back, still bold; the undo stack grew by one', async () => {
    const { body } = await openP6();
    enterState(DOCUMENT_NAME, 'F');
    const marksBefore = charMarks(body.view.state.doc);
    const depth = body.handle.undoManager.undoStack.length;
    deleteOffsets(body.view, at('boldword', 3), at('boldword', 4), 'backspace');
    await flush();
    expectPlans(0);
    expect(body.handle.undoManager.undoStack.length).toBe(depth + 1);
    enterState(DOCUMENT_NAME, 'W');
    body.editor.undo();
    await flush();
    expect(body.view.state.doc.textContent).toBe(P6_TEXT);
    expect(charMarks(body.view.state.doc)).toEqual(marksBefore);
    expectBodyInStep(body);
  });

  it.each(CASES.map((entry) => [`PT-20: in O, ${entry.id} (${entry.what}) is refused with the over-ceiling toast, before any planning`, entry] as const))(
    '%s',
    async (_title, { from, to, how }) => {
      const { body } = await openP6();
      enterState(DOCUMENT_NAME, 'O');
      const cap = capture(body.doc);
      deleteOffsets(body.view, from, to, how);
      await flush();
      expect(body.view.state.doc.textContent).toBe(P6_TEXT);
      expectUntouched(body.doc, cap);
      expectWarnings(COPY.T_OVER);
      expectPlans(0);
    },
  );

  it('PT-20: in O, PT-16 (canvas text node body, deleting lo) is refused with the over-ceiling toast, before any planning', async () => {
    const open = openTiptap('textBody', paragraphs('hello world'));
    enterState(CANVAS_NAME, 'O');
    const cap = capture(open.doc);
    const start = posOf(open.view.state.doc, 'hello', 3);
    select(open.view, start, start + 2);
    press(open.view, 'Backspace');
    await flush();
    expect(paragraphTexts(open.view.state.doc)).toEqual(['hello world']);
    expectUntouched(open.doc, cap);
    expectWarnings(COPY.T_OVER);
    expectPlans(0);
  });

  it('PT-21: in F, Backspace held 30 times through bold, italic and link text: 30 pure deletes, no plan, no toast', async () => {
    // The spec puts the caret at the end of `middle`, which has 26 characters
    // before it; the caret goes at the end of `linkword` instead, so 30
    // presses still end inside `boldword` and cross the italic and link runs.
    const { body } = await openP6();
    enterState(DOCUMENT_NAME, 'F');
    const end = at('linkword', 8);
    select(body.view, posAt(body.view.state.doc, end));
    const shapes: string[] = [];
    for (let k = 0; k < 30; k += 1) {
      const cap = capture(body.doc);
      backspaceChar(body.view);
      await flush();
      shapes.push(`${cap.updates.length}${cap.shape()}`);
      cap.stop();
    }
    expect(shapes).toEqual(Array.from({ length: 30 }, () => '1D'));
    expectPlans(0);
    expectWarnings();
    expect(body.view.state.doc.textContent).toBe(P6_TEXT.slice(0, end - 30) + P6_TEXT.slice(end));
    expectBodyInStep(body);
  });
});
