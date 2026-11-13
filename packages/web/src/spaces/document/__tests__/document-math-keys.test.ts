// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A5, A7, design §6.5, §8.2, §8.3: the body's keys at a formula.
 *
 * A formula holds no text of the body, so the body's caret only passes it
 * whole. At an inline formula the keys open its box the Notion way: ArrowLeft
 * or Backspace right after it with the caret at the end of the source,
 * ArrowRight or Delete right before it with the caret at the start, and our
 * handlers sit ahead of the quote's, the list's and the table cell's own.
 * Beside a block formula, found in reading order, Backspace at a line's start
 * and Delete at a line's end select it first and the next press deletes it,
 * a word or line deletion too; an empty line goes first, as under an image.
 * A divider or an image beside a line still goes in one press. Enter on a
 * selected block formula opens its box.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllSelection, NodeSelection } from '@tiptap/pm/state';

import { open, positionOf, select, shape, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { documentSelectAllExtension } from '@web/spaces/document/document-select-all-guard';

afterEach(unmountAll);

/**
 * Presses a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @param mods - Modifiers held.
 * @returns Whether a handler took it.
 */
function press(editor: Editor, key: string, mods: KeyboardEventInit = {}): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/**
 * Sends a key the way the browser does, to the listeners on the editor's
 * element too.
 * @param editor - The editor.
 * @param key - The key.
 */
function keyDown(editor: Editor, key: string): void {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  view.dom.dispatchEvent(event);
  if (!event.defaultPrevented) view.someProp('handleKeyDown', (handler) => handler(view, event));
}

/**
 * Sends the `beforeinput` a browser fires for a deletion its own key binding
 * makes, such as Ctrl+K.
 * @param editor - The editor.
 * @param inputType - The deletion's inputType.
 * @returns Whether the deletion was cancelled for the browser.
 */
function deletion(editor: Editor, inputType: string): boolean {
  const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
  editor.prosemirrorView!.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

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
 * The open box's text field, once it is there.
 * @returns It.
 */
async function field(): Promise<HTMLTextAreaElement> {
  return vi.waitFor(() => {
    const found = document.querySelector<HTMLTextAreaElement>('[data-formula-box] textarea');
    if (found === null) throw new Error('no box yet');
    return found;
  });
}

/**
 * Whether the selection is the first block formula, whole.
 * @param editor - The editor.
 * @returns True when it is.
 */
function formulaSelected(editor: Editor): boolean {
  const { selection } = editor.prosemirrorView!.state;
  return selection instanceof NodeSelection && selection.node.type.name === 'mathBlock';
}

/** A line with an inline formula between two words, with the given type and props. */
const between = (type = 'paragraph', props: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  props,
  content: ['a ', { type: 'math', props: { source: 'xy' } }, ' b'],
});

describe('the keys right beside an inline formula open its box (A7)', () => {
  it.each([
    ['Backspace right after it', 'Backspace', 'after', 2],
    ['ArrowLeft right after it', 'ArrowLeft', 'after', 2],
    ['Delete right before it', 'Delete', 'before', 0],
    ['ArrowRight right before it', 'ArrowRight', 'before', 0],
  ] as const)('%s opens it with the caret in place, deleting nothing', async (_label, key, side, caret) => {
    const { editor } = open([between()]);
    const at = posOf(editor, 'math');
    select(editor, side === 'after' ? at + 1 : at);
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, key)).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    const text = await field();
    expect(text.selectionStart).toBe(caret);
  });

  it.each([
    ['a quoted line', between('paragraph', { quoted: true })],
    ['a list item', between('bulletListItem')],
    ['a table cell’s first block', tableBlock({ rows: [{ cells: [{ blocks: [between()] }] }] })],
  ])('opens it in %s, ahead of that block’s own Backspace', async (_label, block) => {
    const { editor } = open([block]);
    select(editor, posOf(editor, 'math') + 1);

    expect(press(editor, 'Backspace')).toBe(true);

    await field();
  });

  it('leaves a key elsewhere in the line to the editor', () => {
    const { editor } = open([between()]);
    select(editor, positionOf(editor, ' b', 2));

    expect(press(editor, 'Backspace')).toBe(false);
    expect(press(editor, 'ArrowLeft')).toBe(false);
  });
});

describe('a line beside a block formula (A7)', () => {
  it.each([
    ['Backspace at the start of the line below', 'Backspace', 'below', 0],
    ['Delete at the end of the line above', 'Delete', 'above', 5],
  ] as const)('%s selects the formula, and the next press deletes it', (_label, key, line, offset) => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x+1' } },
      { type: 'paragraph', content: 'below' },
    ]);
    select(editor, positionOf(editor, line, offset));
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, key)).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(formulaSelected(editor)).toBe(true);

    keyDown(editor, key);

    expect(shape(editor)).toEqual(['paragraph:above', 'paragraph:below']);
  });

  it('selects it from the line after it in reading order, past an indented formula', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'parent', children: [{ type: 'mathBlock', props: { source: 'abc' } }] },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'tail', 0));

    expect(press(editor, 'Backspace')).toBe(true);

    expect(formulaSelected(editor)).toBe(true);
  });

  it.each([
    [
      'the end of an indented line above an outer formula',
      [
        { type: 'paragraph', content: 'parent', children: [{ type: 'paragraph', content: 'kid' }] },
        { type: 'mathBlock', props: { source: 'abc' } },
      ],
      'kid',
    ],
    [
      'the end of a line with the formula indented under it',
      [{ type: 'paragraph', content: 'above', children: [{ type: 'mathBlock', props: { source: 'abc' } }] }],
      'above',
    ],
  ])('Delete at %s selects the formula instead of deleting it', (_label, body, line) => {
    const { editor } = open(body);
    select(editor, positionOf(editor, line, line.length));
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Delete')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(formulaSelected(editor)).toBe(true);
  });

  it('removes an empty line under it first and selects the formula, as under an image', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x+1' } },
      { type: 'paragraph', content: '' },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, positionOf(editor, 'tail', 0) - 4);

    expect(press(editor, 'Backspace')).toBe(true);

    expect(shape(editor)).toEqual(['paragraph:above', 'mathBlock:', 'paragraph:tail']);
    expect(formulaSelected(editor)).toBe(true);
  });

  it('keeps an empty line that has a line indented under it', () => {
    const { editor } = open([
      { type: 'mathBlock', props: { source: 'x' } },
      { type: 'paragraph', content: '', children: [{ type: 'paragraph', content: 'kid' }] },
    ]);
    select(editor, posOf(editor, 'paragraph') + 1);

    expect(press(editor, 'Backspace')).toBe(true);

    expect(formulaSelected(editor)).toBe(true);
    expect(editor.prosemirrorView!.state.doc.textContent).toContain('kid');
  });

  it('selects it from the start of a quoted line', () => {
    const { editor } = open([
      { type: 'mathBlock', props: { source: 'abc' } },
      { type: 'paragraph', props: { quoted: true }, content: 'q' },
    ]);
    select(editor, positionOf(editor, 'q', 0));

    expect(press(editor, 'Backspace')).toBe(true);

    expect(formulaSelected(editor)).toBe(true);
  });

  it('lets a heading take its own first step on Backspace, turning into a line', () => {
    const { editor } = open([
      { type: 'mathBlock', props: { source: 'abc' } },
      { type: 'heading', props: { level: 2 }, content: 'title' },
    ]);
    select(editor, positionOf(editor, 'title', 0));

    keyDown(editor, 'Backspace');

    expect(formulaSelected(editor)).toBe(false);
    expect(shape(editor)).toEqual(['mathBlock:', 'paragraph:title']);
  });

  it('selects it on a word deletion from the line start, and on a line deletion the browser makes', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x+1' } },
      { type: 'paragraph', content: 'below' },
    ]);
    select(editor, positionOf(editor, 'below', 0));
    expect(press(editor, 'Backspace', { ctrlKey: true })).toBe(true);
    expect(formulaSelected(editor)).toBe(true);

    select(editor, positionOf(editor, 'above', 5));
    expect(deletion(editor, 'deleteHardLineForward')).toBe(true);
    expect(formulaSelected(editor)).toBe(true);
    expect(shape(editor)).toEqual(['paragraph:above', 'mathBlock:', 'paragraph:below']);
  });

  it.each([
    ['a divider', { type: 'divider' }, 'divider'],
    ['an image', { type: 'image', props: { url: 'https://cdn.example/a.png' } }, 'image'],
  ])('leaves %s beside a line to go in one press', (_label, block, name) => {
    const { editor } = open([block, { type: 'paragraph', content: 'below' }]);
    select(editor, positionOf(editor, 'below', 0));

    keyDown(editor, 'Backspace');

    expect(posOf(editor, name)).toBe(-1);
  });

  it('opens the box of a selected formula on Enter', async () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x+1' } },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, posOf(editor, 'mathBlock'))));

    expect(press(editor, 'Enter')).toBe(true);

    expect((await field()).value).toBe('x+1');
  });
});

describe('a formula at the edge of the whole document or of a table cell (A7)', () => {
  it('asks before Backspace deletes a whole document that opens with a formula', () => {
    const ask = vi.fn();
    const { editor } = open(
      [
        { type: 'mathBlock', props: { source: 'aaa' } },
        { type: 'paragraph', content: 'head words' },
      ],
      { extensions: [documentSelectAllExtension(ask)] },
    );
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    const before = view.state.doc;

    keyDown(editor, 'Backspace');

    expect(ask).toHaveBeenCalledTimes(1);
    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
  });

  it.each([
    ['Backspace', [{ type: 'mathBlock', props: { source: '' } }, { type: 'paragraph', content: 'c2' }], 0],
    ['Delete', [{ type: 'paragraph', content: 'c2' }, { type: 'mathBlock', props: { source: '' } }], 2],
  ] as const)('%s on an emptied formula at a cell edge keeps the caret in that cell', async (key, cell, offset) => {
    const { editor } = open([tableBlock({ rows: [{ cells: ['c1', { blocks: [...cell] }, 'c3'] }] })]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, posOf(editor, 'mathBlock'))));
    press(editor, 'Enter');
    const text = await field();

    text.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    const { $from } = editor.prosemirrorView!.state.selection;
    expect($from.parent.textContent).toBe('c2');
    expect($from.parentOffset).toBe(offset);
  });
});
