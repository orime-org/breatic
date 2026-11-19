// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 A5, A7, A13, design §6.3, §8.2, §8.3: a formula's box.
 *
 * The source is edited in a text field in a box under the formula, and each
 * change is written to the formula's `source` straight away: the formula in
 * the body is the live preview. Enter, the confirm button, Escape and moving
 * away all close the box and keep the edit; the box has no close button.
 * Cmd+Z in the field undoes through the body's undo stack. An empty source
 * goes with Backspace or Delete. When the formula goes while the field holds
 * the keyboard, the keyboard goes back to the body.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { t } from '@breatic/shared';

import { open, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

/** The open box. */
const BOX = '[data-formula-box]';

/**
 * Where the first node of a type starts.
 * @param editor - The editor.
 * @param name - The node type.
 * @returns Its position, or -1.
 */
function posOf(editor: Editor, name: string): number {
  let at = -1;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The first formula's source.
 * @param editor - The editor.
 * @param name - `mathBlock` or `math`.
 * @returns It.
 */
function sourceIn(editor: Editor, name: string): string {
  return String(editor.prosemirrorView!.state.doc.nodeAt(posOf(editor, name))!.attrs['source']);
}

/**
 * The box's text field, once it is there.
 * @returns It.
 */
async function field(): Promise<HTMLTextAreaElement> {
  return vi.waitFor(() => {
    const found = document.querySelector<HTMLTextAreaElement>(`${BOX} textarea`);
    if (found === null) throw new Error('no box yet');
    return found;
  });
}

/**
 * Opens a formula's box with a press on the drawn formula, as a click does.
 * @param selector - The drawn formula.
 * @returns The box's text field.
 */
async function openBy(selector: string): Promise<HTMLTextAreaElement> {
  const drawn = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`no ${selector} yet`);
    return found;
  });
  fireEvent.mouseDown(drawn);
  return field();
}

/**
 * Whether no box is open.
 * @returns True when none is.
 */
function closed(): boolean {
  return document.querySelector(BOX) === null;
}

/** A block formula between two lines. */
const BLOCK = [
  { type: 'paragraph', content: 'above' },
  { type: 'mathBlock', props: { source: 'x+1' } },
  { type: 'paragraph', content: 'below' },
];

/** A line with an inline formula between two words. */
const INLINE = [{ type: 'paragraph', content: ['a ', { type: 'math', props: { source: 'xy' } }, ' b'] }];

describe('the box (A5)', () => {
  it('opens on a press on the formula with the caret at the end of the source', async () => {
    open(BLOCK);
    const text = await openBy('.katex-display');

    expect(text.value).toBe('x+1');
    expect(document.activeElement).toBe(text);
    expect(text.selectionStart).toBe(3);
  });

  it('carries the title and the confirm button below the field, and no close button', async () => {
    open(BLOCK);
    const text = await openBy('.katex-display');
    const box = document.querySelector<HTMLElement>(BOX)!;

    expect(box.textContent).toContain(t('spaces.document.commands.formula'));
    expect(box.querySelectorAll('button')).toHaveLength(1);
    const confirm = box.querySelector('button')!;
    expect(confirm.textContent).toBe(t('spaces.document.math.ok'));
    expect(text.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('writes each change to the source as it is typed', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');

    fireEvent.change(text, { target: { value: 'x+12' } });

    expect(sourceIn(editor, 'mathBlock')).toBe('x+12');
  });

  it('writes what an input method composes once the composition ends', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');

    fireEvent.compositionStart(text);
    fireEvent.change(text, { target: { value: 'x+1ni' } });
    expect(sourceIn(editor, 'mathBlock')).toBe('x+1');
    fireEvent.compositionEnd(text, { target: { value: 'x+1你' } });

    expect(sourceIn(editor, 'mathBlock')).toBe('x+1你');
  });

  it.each([
    ['a block formula, selected whole', BLOCK, '.katex-display', 'mathBlock'],
    ['an inline formula, the caret right after it', INLINE, '.katex', 'math'],
  ] as const)('puts the body’s selection on %s when a press opens it, so an undo lands there (§8.2)', async (_label, blocks, selector, name) => {
    const { editor } = open([{ type: 'paragraph', content: 'far away' }, ...blocks]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));

    await openBy(selector);

    const { selection } = view.state;
    const at = posOf(editor, name);
    if (name === 'mathBlock') expect(selection instanceof NodeSelection && selection.from === at).toBe(true);
    else expect(selection.from).toBe(at + 1);
  });

  it('follows a collaborator who changes the source while it is open', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    const view = editor.prosemirrorView!;
    const at = posOf(editor, 'mathBlock');

    act(() => {
      view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...view.state.doc.nodeAt(at)!.attrs, source: 'y' }));
    });

    await vi.waitFor(() => {
      expect(text.value).toBe('y');
    });
    expect(closed()).toBe(false);
  });
});

describe('closing a block formula’s box (§8.2)', () => {
  it.each([
    ['the confirm button', (text: HTMLTextAreaElement) => fireEvent.click(text.closest(BOX)!.querySelector('button')!)],
    ['Enter', (text: HTMLTextAreaElement) => fireEvent.keyDown(text, { key: 'Enter' })],
    ['Escape', (text: HTMLTextAreaElement) => fireEvent.keyDown(text, { key: 'Escape' })],
  ])('keeps the edit on %s and selects the formula whole', async (_how, close) => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value: 'x+2' } });

    close(text);

    expect(closed()).toBe(true);
    expect(sourceIn(editor, 'mathBlock')).toBe('x+2');
    const { selection } = editor.prosemirrorView!.state;
    expect(selection instanceof NodeSelection && selection.node.type.name === 'mathBlock').toBe(true);
  });

  it('keeps the edit when the keyboard moves away', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value: 'x+3' } });

    fireEvent.blur(text, { relatedTarget: null });

    expect(closed()).toBe(true);
    expect(sourceIn(editor, 'mathBlock')).toBe('x+3');
  });

  it('selects the formula and hands the keyboard to the body when the whole window loses focus (§8.2)', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    fireEvent.blur(text, { relatedTarget: null });

    expect(closed()).toBe(true);
    const { selection } = editor.prosemirrorView!.state;
    expect(selection instanceof NodeSelection && selection.node.type.name === 'mathBlock').toBe(true);
    expect(document.activeElement).toBe(editor.prosemirrorView!.dom);
  });

  it.each([
    ['Enter that accepts a candidate', 'Enter', 13, 'x+1'],
    ['Escape that dismisses the candidates', 'Escape', 27, 'x+1'],
    ['Backspace that erases the reading', 'Backspace', 8, ''],
  ] as const)('leaves the %s to the input method (§8.2)', async (_label, key, keyCode, value) => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value } });
    fireEvent.compositionStart(text);

    // Chrome ends the composition first, then sends the key with isComposing
    // false, once as 229 and again with its own code.
    fireEvent.compositionEnd(text, { target: { value } });
    fireEvent.keyDown(text, { key, keyCode: 229 });
    fireEvent.keyDown(text, { key, keyCode });

    expect(closed()).toBe(false);
    expect(posOf(editor, 'mathBlock')).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['ArrowUp at the start of the source', 'ArrowUp', 0, 'above', 5],
    ['ArrowDown at the end of the source', 'ArrowDown', 3, 'below', 0],
  ] as const)('closes on %s, the caret on the line beside it', async (_label, key, at, line, offset) => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    text.setSelectionRange(at, at);

    fireEvent.keyDown(text, { key });

    expect(closed()).toBe(true);
    const { $from } = editor.prosemirrorView!.state.selection;
    expect($from.parent.textContent).toBe(line);
    expect($from.parentOffset).toBe(offset);
  });

  it('removes the formula with Delete in an empty source, the caret at the start of the line below', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value: '' } });

    fireEvent.keyDown(text, { key: 'Delete' });

    expect(posOf(editor, 'mathBlock')).toBe(-1);
    const { $from } = editor.prosemirrorView!.state.selection;
    expect($from.parent.textContent).toBe('below');
    expect($from.parentOffset).toBe(0);
  });

  it('keeps the lines indented under a formula removed from an empty source, lifted into its place', async () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x' }, children: [{ type: 'paragraph', content: 'kid' }] },
    ]);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value: '' } });

    fireEvent.keyDown(text, { key: 'Backspace' });

    expect(posOf(editor, 'mathBlock')).toBe(-1);
    expect(editor.prosemirrorView!.state.doc.textContent).toBe('abovekid');
  });

  it('leaves Shift+Enter to the field, a new line in the source', async () => {
    open(BLOCK);
    const text = await openBy('.katex-display');

    expect(fireEvent.keyDown(text, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(closed()).toBe(false);
  });

  it('removes the formula with Backspace in an empty source, the caret at the end of the line above', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value: '' } });

    fireEvent.keyDown(text, { key: 'Backspace' });

    expect(posOf(editor, 'mathBlock')).toBe(-1);
    const { $from } = editor.prosemirrorView!.state.selection;
    expect($from.parent.textContent).toBe('above');
    expect($from.parentOffset).toBe(5);
  });
});

describe('closing an inline formula’s box (§8.3)', () => {
  it.each([
    ['Enter', 'Enter'],
    ['Escape', 'Escape'],
    ['ArrowUp', 'ArrowUp'],
    ['ArrowRight at the end of the source', 'ArrowRight'],
  ] as const)('keeps the edit on %s, the caret right after the formula', async (_how, key) => {
    const { editor } = open(INLINE);
    const text = await openBy('.katex');
    fireEvent.change(text, { target: { value: 'xyz' } });

    fireEvent.keyDown(text, { key });

    expect(closed()).toBe(true);
    expect(sourceIn(editor, 'math')).toBe('xyz');
    const at = posOf(editor, 'math');
    expect(editor.prosemirrorView!.state.selection.from).toBe(at + 1);
  });

  it('puts the caret right before the formula on ArrowLeft at the start of the source', async () => {
    const { editor } = open(INLINE);
    const text = await openBy('.katex');
    text.setSelectionRange(0, 0);

    fireEvent.keyDown(text, { key: 'ArrowLeft' });

    expect(closed()).toBe(true);
    expect(editor.prosemirrorView!.state.selection.from).toBe(posOf(editor, 'math'));
  });

  it('leaves ArrowLeft inside the source to the field', async () => {
    open(INLINE);
    const text = await openBy('.katex');

    expect(fireEvent.keyDown(text, { key: 'ArrowLeft' })).toBe(true);
    expect(closed()).toBe(false);
  });

  it('removes the formula with Delete in an empty source, the caret where it was', async () => {
    const { editor } = open(INLINE);
    const at = posOf(editor, 'math');
    const text = await openBy('.katex');
    fireEvent.change(text, { target: { value: '' } });

    fireEvent.keyDown(text, { key: 'Delete' });

    expect(posOf(editor, 'math')).toBe(-1);
    expect(editor.prosemirrorView!.state.selection.from).toBe(at);
  });
});

describe('undo from the box (A5)', () => {
  it('undoes the typing through the body’s undo stack', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');
    fireEvent.change(text, { target: { value: 'x+9' } });

    fireEvent.keyDown(text, { key: 'z', ctrlKey: true });

    expect(sourceIn(editor, 'mathBlock')).toBe('x+1');
  });

  it('gives the keyboard back to the body when the undo takes the formula away', async () => {
    const { editor, manager } = open([{ type: 'paragraph', content: 'above' }]);
    editor.insertBlocks([{ type: 'mathBlock', props: { source: 'x' } }] as never, editor.document[0]!, 'after');
    manager.stopCapturing();
    const text = await openBy('.katex-display');

    fireEvent.keyDown(text, { key: 'z', ctrlKey: true });

    expect(posOf(editor, 'mathBlock')).toBe(-1);
    expect(document.activeElement).toBe(editor.prosemirrorView!.dom);
    expect(editor.prosemirrorView!.state.selection instanceof TextSelection).toBe(true);
  });
});

describe('a read-only body', () => {
  it('does not open the box on a press', async () => {
    const { editor } = open(BLOCK);
    editor.isEditable = false;
    const drawn = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('.katex-display');
      if (found === null) throw new Error('no formula yet');
      return found;
    });

    fireEvent.mouseDown(drawn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closed()).toBe(true);
  });

  it('closes an open box when the body turns read-only', async () => {
    const { editor } = open(BLOCK);
    await openBy('.katex-display');

    act(() => {
      editor.isEditable = false;
    });

    await vi.waitFor(() => {
      expect(closed()).toBe(true);
    });
    // Closed for good: the box does not come back when the body can be edited again.
    act(() => {
      editor.isEditable = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed()).toBe(true);
  });
});

describe('a source that does not parse', () => {
  it('turns the field red while it says what is wrong, as other fields with an error line do', async () => {
    const { editor } = open(BLOCK);
    const text = await openBy('.katex-display');

    fireEvent.change(text, { target: { value: '\\frac{a' } });
    expect(sourceIn(editor, 'mathBlock')).toBe('\\frac{a');
    expect(text.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(text, { target: { value: '\\frac{a}{b}' } });
    expect(text.getAttribute('aria-invalid')).toBeNull();
  });
});
