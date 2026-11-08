// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec section 12: the delete executor on the canvas
 * TipTap editors (the text node body, the prompt, the lyrics), bound to the
 * `XmlFragment` nested in a canvas node; the document name comes from
 * `docNameOf(fragment.doc)`. Content arrives as a remote update (spec 0.1)
 * and each accepted case follows the executor template X, undoing through
 * y-tiptap's `undo` command (`gatedHistoryStep`).
 *
 * The prompt and lyrics carry the reference chip extension, whose deletion
 * unit takes a chip together with the spaces it owns, and whose whitespace
 * plugin keeps a space on each side of every chip; the contents below are
 * written with those spaces, as the editor keeps them.
 *
 * While full every deletion goes to the executor, a deletion of text inside
 * one `XmlText` included (1 plan, counted by a pass-through spy on the
 * executor module). Over the ceiling, deleting part of one `XmlText` is
 * refused before planning (design 5.3 step 7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@web/features/collab-editor/space-delete-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof Executor>();
  return { ...actual, planSpaceDelete: vi.fn(actual.planSpaceDelete) };
});

import { changeLocale } from '@web/i18n/locale-bootstrap';
import { yUndoPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import type * as Executor from '@web/features/collab-editor/space-delete-executor';
import { planSpaceDelete } from '@web/features/collab-editor/space-delete-executor';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { dispatchMachineEdit } from '@web/features/reference-mention/reference-mention-local-input';
import { planCascadeDeletion } from '@web/features/reference-mention/reference-mention-whitespace';
import {
  CANVAS_NAME,
  CHIP_A,
  COPY,
  backspaceChar,
  capture,
  chipParagraph,
  clearToasts,
  enterState,
  expectCaretNear,
  expectTiptapInStep,
  expectUntouched,
  expectWarnings,
  flush,
  nodesOf,
  openTiptap,
  paragraphTexts,
  paragraphs,
  posOf,
  press,
  resetHarness,
  select,
  typeText,
  type Capture,
  type OpenTiptap,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

/**
 * The undo stack y-tiptap keeps for the editor.
 * @param open - The open editor.
 * @returns Its manager.
 */
function undoManagerOf(open: OpenTiptap): Y.UndoManager {
  return (yUndoPluginKey.getState(open.view.state) as { undoManager: Y.UndoManager }).undoManager;
}

/**
 * Template X items 1 to 4 and 6 for a TipTap editor.
 * @param open - The open editor.
 * @param cap - The capture.
 * @param expected - The case.
 * @param expected.texts - The paragraphs after.
 * @param expected.shape - The shape of the one update.
 * @param expected.start - The range start in the document before.
 */
function expectAccepted(open: OpenTiptap, cap: Capture, expected: { texts: string[]; shape: 'D' | 'R'; start: number }): void {
  expect(cap.updates).toHaveLength(1);
  expect(cap.shape()).toBe(expected.shape);
  expect(paragraphTexts(open.view.state.doc)).toEqual(expected.texts);
  expectTiptapInStep(open);
  expectWarnings();
  expectCaretNear(open.view, expected.start);
}

/**
 * Template X item 5: back to warning, one y-tiptap undo restores the paragraphs.
 * @param open - The open editor.
 * @param before - The paragraphs before.
 */
async function expectUndoRestores(open: OpenTiptap, before: string[]): Promise<void> {
  enterState(CANVAS_NAME, 'W');
  open.editor.commands.undo();
  await flush();
  expect(paragraphTexts(open.view.state.doc)).toEqual(before);
  expectTiptapInStep(open);
}

/**
 * The source ids of the chips in the editor, in order.
 * @param view - The view.
 * @returns The ids.
 */
function chipIds(view: EditorView): string[] {
  return nodesOf(view.state.doc, REFERENCE_MENTION_NODE).map((pos) => view.state.doc.nodeAt(pos)!.attrs['sourceNodeId'] as string);
}

/**
 * Selects the chip with a node selection and presses Backspace, as a user deleting it does.
 * @param open - The open editor.
 * @returns The chip's position.
 */
function deleteChip(open: OpenTiptap): number {
  const at = nodesOf(open.view.state.doc, REFERENCE_MENTION_NODE)[0];
  open.view.dispatch(open.view.state.tr.setSelection(NodeSelection.create(open.view.state.doc, at)));
  press(open.view, 'Backspace');
  return at;
}

/**
 * Asserts how many times the filter asked the executor to plan.
 * @param times - The expected count.
 */
function expectPlans(times: number): void {
  expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(times);
}

beforeEach(() => {
  changeLocale('en');
  clearToasts();
  vi.mocked(planSpaceDelete).mockClear();
});

afterEach(() => {
  resetHarness();
});

describe('12. the delete executor on the canvas TipTap editors', () => {
  it('XT-01: text node body in F, deleting text inside a paragraph goes to the executor (D)', async () => {
    const open = openTiptap('textBody', paragraphs('hello world'));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    const start = posOf(open.view.state.doc, 'hello', 3);
    select(open.view, start, start + 4);
    press(open.view, 'Backspace');
    await flush();
    expectAccepted(open, cap, { texts: ['helorld'], shape: 'D', start });
    expectPlans(1);
    await expectUndoRestores(open, ['hello world']);
  });

  it('XT-02: text node body in F, select all and delete leaves one empty paragraph (R)', async () => {
    const open = openTiptap('textBody', paragraphs('a', 'b'));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    press(open.view, 'a', { mod: true });
    press(open.view, 'Backspace');
    await flush();
    expectAccepted(open, cap, { texts: [''], shape: 'R', start: 1 });
    await expectUndoRestores(open, ['a', 'b']);
  });

  /**
   * Opens a prompt `ab <chip> cd` and deletes the chip with its owned spaces.
   * @returns The open prompt, its capture and the chip's position.
   */
  async function deleteChipFromPrompt(): Promise<{ open: OpenTiptap; cap: Capture; start: number }> {
    const open = openTiptap('prompt', chipParagraph('ab ', CHIP_A, ' cd'));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    const start = deleteChip(open);
    await flush();
    return { open, cap, start };
  }

  it('XT-03: prompt in F, deleting a chip goes to the executor, which takes it with its spaces; the text joins up', async () => {
    const { open, cap, start } = await deleteChipFromPrompt();
    expectPlans(1);
    // The chip's deletion unit holds its two spaces, which are text: the
    // update deletes the chip element and two characters (D).
    expectAccepted(open, cap, { texts: ['abcd'], shape: 'D', start: start - 1 });
    expect(chipIds(open.view)).toEqual([]);
    await expectUndoRestores(open, ['ab  cd']);
    expect(chipIds(open.view)).toEqual(['a']);
  });

  it.each([
    { what: 'a delete across the old seam (bc)', offset: 1, length: 2, texts: ['ad'] },
    { what: 'deleting b alone', offset: 1, length: 1, texts: ['acd'] },
    { what: 'deleting c alone', offset: 2, length: 1, texts: ['abd'] },
  ])('XT-04: after XT-03, $what goes to the executor and is one pure delete (D)', async ({ offset, length, texts }) => {
    const { open } = await deleteChipFromPrompt();
    vi.mocked(planSpaceDelete).mockClear();
    const cap = capture(open.doc);
    const start = posOf(open.view.state.doc, 'abcd', offset);
    select(open.view, start, start + length);
    press(open.view, 'Backspace');
    await flush();
    expectAccepted(open, cap, { texts, shape: 'D', start });
    expectPlans(1);
  });

  it('XT-04: after XT-03, selecting all of the paragraph goes to the executor and deletes both XmlTexts (R)', async () => {
    const { open } = await deleteChipFromPrompt();
    vi.mocked(planSpaceDelete).mockClear();
    const cap = capture(open.doc);
    press(open.view, 'a', { mod: true });
    press(open.view, 'Backspace');
    await flush();
    expectAccepted(open, cap, { texts: [''], shape: 'R', start: 1 });
    expectPlans(1);
  });

  it('XT-05: prompt in F, the automatic removal of a chip whose source left the pool goes through the executor, off the undo stack', async () => {
    const open = openTiptap('prompt', chipParagraph('ab ', CHIP_A, ' cd'));
    enterState(CANVAS_NAME, 'F');
    const depth = undoManagerOf(open).undoStack.length;
    const cap = capture(open.doc);
    // What PromptEditor does when the reference edge goes (PromptEditor.tsx cascade effect).
    const chips = new Set(nodesOf(open.view.state.doc, REFERENCE_MENTION_NODE));
    const tr = open.view.state.tr;
    for (const { from, to } of planCascadeDeletion(open.view.state.doc, chips)) tr.delete(from, to);
    dispatchMachineEdit(open.view, tr);
    await flush();
    expect(chipIds(open.view)).toEqual([]);
    expect(cap.updates).toHaveLength(1);
    // The cascade takes the chip's owned spaces too, which are text (D).
    expect(cap.shape()).toBe('D');
    expectTiptapInStep(open);
    expect(undoManagerOf(open).undoStack.length).toBe(depth);
    expectWarnings();
  });

  it('XT-06: prompt in F, the user\'s Backspace goes to the executor, goes on the undo stack and comes back after warning', async () => {
    const open = openTiptap('prompt', paragraphs('hello world'));
    enterState(CANVAS_NAME, 'F');
    const depth = undoManagerOf(open).undoStack.length;
    const cap = capture(open.doc);
    const start = posOf(open.view.state.doc, 'world', 5);
    select(open.view, start);
    backspaceChar(open.view);
    await flush();
    expectAccepted(open, cap, { texts: ['hello worl'], shape: 'D', start: start - 1 });
    expectPlans(1);
    expect(undoManagerOf(open).undoStack.length).toBe(depth + 1);
    await expectUndoRestores(open, ['hello world']);
  });

  it('XT-07: lyrics in O, deleting one character is refused with the over-ceiling toast, before any planning', async () => {
    const open = openTiptap('lyrics', paragraphs('la la'));
    enterState(CANVAS_NAME, 'O');
    const cap = capture(open.doc);
    select(open.view, posOf(open.view.state.doc, 'la la', 5));
    backspaceChar(open.view);
    await flush();
    expect(paragraphTexts(open.view.state.doc)).toEqual(['la la']);
    expectUntouched(open.doc, cap);
    expectWarnings(COPY.T_OVER);
    expectPlans(0);
  });

  /**
   * Selects a needle.
   * @param view - The view.
   * @param needle - Text.
   */
  function selectText(view: EditorView, needle: string): void {
    const from = posOf(view.state.doc, needle);
    select(view, from, from + needle.length);
  }

  /**
   * Puts the caret right after a needle.
   * @param view - The view.
   * @param needle - Text.
   */
  function caretAfter(view: EditorView, needle: string): void {
    select(view, posOf(view.state.doc, needle, needle.length));
  }

  it.each([
    { op: 'typing z', texts: ['hello world'], run: (view: EditorView) => { caretAfter(view, 'hello'); typeText(view, 'z'); }, toast: COPY.T_ADD },
    { op: 'pasting abc', texts: ['hello world'], run: (view: EditorView) => { caretAfter(view, 'hello'); view.pasteText('abc'); }, toast: COPY.T_ADD },
    { op: 'Enter', texts: ['hello world'], run: (view: EditorView) => { caretAfter(view, 'hello'); press(view, 'Enter'); }, toast: COPY.T_ADD },
    { op: 'Enter over a selected word', texts: ['hello world'], run: (view: EditorView) => { selectText(view, 'world'); press(view, 'Enter'); }, toast: COPY.T_ADD },
    { op: 'typing w over world', texts: ['hello world'], run: (view: EditorView) => { selectText(view, 'world'); typeText(view, 'w'); }, toast: COPY.T_ADD },
    { op: 'pasting lunch over launch', texts: ['launch'], run: (view: EditorView) => { selectText(view, 'launch'); view.pasteText('lunch'); }, toast: COPY.T_ADD },
    { op: 'typing z over world', texts: ['hello world'], run: (view: EditorView) => { selectText(view, 'world'); typeText(view, 'z'); }, toast: COPY.T_ADD },
    { op: 'Backspace joining two paragraphs', texts: ['Hello', 'World'], run: (view: EditorView) => { select(view, posOf(view.state.doc, 'World')); press(view, 'Backspace'); }, toast: COPY.T_COMPOUND },
  ])('XT-08: prompt in F, $op is refused with its toast', async ({ texts, run, toast }) => {
    const open = openTiptap('prompt', paragraphs(...texts));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    const before = open.view.state.doc;
    run(open.view);
    await flush();
    expect(open.view.state.doc.eq(before)).toBe(true);
    expectUntouched(open.doc, cap);
    expectWarnings(toast);
  });
});
