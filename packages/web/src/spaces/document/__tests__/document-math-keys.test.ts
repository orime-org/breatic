// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A5, A7: the keys around and inside a formula (design 6.2, 6.5).
 *
 * An inline formula is entered with the keys, the way Notion and BlockNote's
 * own do: Backspace right after it, or Delete right before it, puts the caret
 * into its source instead of deleting a character the user cannot see; an
 * empty source goes with one more press. Our own key handlers in front of the
 * library's (Enter in a quote, the table's Backspace, the select-all guard)
 * step aside for a formula's source.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SourceBlockWithPreviewExtension } from '@blocknote/core/extensions';

import { open, positionOf, select, shape, type, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { documentSelectAllExtension } from '@web/spaces/document/document-select-all-guard';

afterEach(unmountAll);

/** A block as this file reads it back. */
interface Seen {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly Seen[];
}

/**
 * Presses a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @param ctrlKey - Whether Ctrl is held (`Mod` in jsdom, which is not a Mac).
 * @param shiftKey - Whether Shift is held.
 * @returns Whether a handler took it.
 */
function press(editor: Editor, key: string, ctrlKey = false, shiftKey = false): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, ctrlKey, shiftKey, bubbles: true, cancelable: true });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
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
 * The first inline formula's source range.
 * @param editor - The editor.
 * @returns Where its source starts and ends.
 */
function source(editor: Editor): { start: number; end: number; after: number } {
  const at = posOf(editor, 'math');
  const node = editor.prosemirrorView!.state.doc.nodeAt(at)!;
  return { start: at + 1, end: at + node.nodeSize - 1, after: at + node.nodeSize };
}

/**
 * How many inline formulas the document holds.
 * @param editor - The editor.
 * @returns The count.
 */
function formulas(editor: Editor): number {
  let count = 0;
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.type.name === 'math') count += 1;
  });
  return count;
}

/**
 * Whether the block formula's popup is open.
 * @param editor - The editor.
 * @param id - The formula block's id.
 * @returns True when it is.
 */
function popupOpen(editor: Editor, id: string): boolean {
  return editor.getExtension(SourceBlockWithPreviewExtension)?.store.state.popupOpen === id;
}

/**
 * The top-level blocks.
 * @param editor - The editor.
 * @returns Them.
 */
function blocks(editor: Editor): Seen[] {
  return editor.document as unknown as Seen[];
}

/** A paragraph holding a formula between two words, with the given props. */
const between = (src: string, props: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'paragraph',
  props,
  content: ['a ', { type: 'math', content: src }, ' b'],
});

describe('an inline formula beside the caret (A7)', () => {
  it('Backspace right after it moves the caret to the end of its source and deletes nothing', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).after);
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Backspace')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).end);
  });

  it('Delete right before it moves the caret to the start of its source and deletes nothing', () => {
    const { editor } = open([between('xy')]);
    select(editor, posOf(editor, 'math'));
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Delete')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).start);
  });

  it.each([
    ['Shift+Backspace right after it', 'Backspace', 'after', 'end'],
    ['Shift+Delete right before it', 'Delete', 'before', 'start'],
  ] as const)('%s moves the caret into its source and deletes nothing', (_label, key, from, into) => {
    const { editor } = open([between('xy')]);
    select(editor, from === 'after' ? source(editor).after : posOf(editor, 'math'));
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, key, false, true)).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor)[into]);
  });

  it('Delete at the end of its source does nothing to the line after it', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).end);
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Delete')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).end);
  });

  it('leaves Delete inside its source to the browser', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).start + 1);

    expect(press(editor, 'Delete')).toBe(false);
  });

  it.each(['Backspace', 'Delete'])('%s in an empty source deletes the formula', (key) => {
    const { editor } = open([between('')]);
    const at = posOf(editor, 'math');
    select(editor, source(editor).start);

    expect(press(editor, key)).toBe(true);

    expect(formulas(editor)).toBe(0);
    expect(editor.prosemirrorView!.state.selection.from).toBe(at);
  });
});

describe('an inline formula where our own Backspace handlers sit first (A7)', () => {
  it('in a table cell’s first block, Backspace right after it enters its source', () => {
    const { editor } = open([tableBlock({ rows: [{ cells: [{ blocks: [between('xy')] }] }] })]);
    select(editor, source(editor).after);

    press(editor, 'Backspace');

    expect(formulas(editor)).toBe(1);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).end);
  });

  it('in a table cell’s first block, Backspace in an empty source deletes the formula', () => {
    const { editor } = open([
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'paragraph', content: [{ type: 'math', content: '' }] }] }] }] }),
    ]);
    select(editor, source(editor).start);

    expect(press(editor, 'Backspace')).toBe(true);

    expect(formulas(editor)).toBe(0);
    expect(blocks(editor)[0]!.type).toBe('docTable');
  });

  it('right below a table, Backspace in an empty source deletes the formula and stays in the line', () => {
    const { editor } = open([
      tableBlock({ rows: [{ cells: ['cell'] }] }),
      { type: 'paragraph', content: [{ type: 'math', content: '' }] },
    ]);
    const at = posOf(editor, 'math');
    select(editor, source(editor).start);

    expect(press(editor, 'Backspace')).toBe(true);

    expect(formulas(editor)).toBe(0);
    expect(editor.prosemirrorView!.state.selection.from).toBe(at);
  });

  it('right below a table, Backspace at the start of a source leaves the caret in it', () => {
    const { editor } = open([
      tableBlock({ rows: [{ cells: ['cell'] }] }),
      { type: 'paragraph', content: [{ type: 'math', content: 'xy' }] },
    ]);
    select(editor, source(editor).start);
    const before = editor.prosemirrorView!.state.doc;

    press(editor, 'Backspace');

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).start);
  });

  it('in a quoted line, Backspace in an empty source deletes the formula and keeps the quote', () => {
    const { editor } = open([{ type: 'paragraph', props: { quoted: true }, content: [{ type: 'math', content: '' }] }]);
    select(editor, source(editor).start);

    expect(press(editor, 'Backspace')).toBe(true);

    expect(formulas(editor)).toBe(0);
    expect(blocks(editor)[0]!.props['quoted']).toBe(true);
  });

  it('in a quoted line, Backspace at the start of a source keeps the quote', () => {
    const { editor } = open([{ type: 'paragraph', props: { quoted: true }, content: [{ type: 'math', content: 'xy' }] }]);
    select(editor, source(editor).start);
    const before = editor.prosemirrorView!.state.doc;

    press(editor, 'Backspace');

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(blocks(editor)[0]!.props['quoted']).toBe(true);
  });

  it('in a quoted line, Backspace right after it enters its source', () => {
    const { editor } = open([between('xy', { quoted: true })]);
    select(editor, source(editor).after);

    press(editor, 'Backspace');

    expect(formulas(editor)).toBe(1);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).end);
    expect(blocks(editor)[0]!.props['quoted']).toBe(true);
  });
});

describe('a block formula with its popup open (A5, A7)', () => {
  /**
   * Opens the popup on the formula block the way a user does, with Enter on
   * the selected block, then puts the caret at the start of its source.
   * @param editor - The editor.
   * @returns The formula block's id.
   */
  function openPopupAtStart(editor: Editor): string {
    const id = (function find(list: readonly Seen[]): string {
      for (const block of list) {
        if (block.type === 'mathBlock') return block.id;
        const inner = find(block.children);
        if (inner !== '') return inner;
      }
      return '';
    })(blocks(editor));
    editor.setTextCursorPosition(id, 'end');
    press(editor, 'Enter');
    expect(popupOpen(editor, id)).toBe(true);
    select(editor, posOf(editor, 'mathBlock') + 1);
    return id;
  }

  it('Backspace at the start of a source does nothing to the empty block above', () => {
    const { editor } = open([
      { type: 'paragraph', content: '' },
      { type: 'mathBlock', content: 'x+1' },
    ]);
    const id = openPopupAtStart(editor);
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Backspace')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(popupOpen(editor, id)).toBe(true);
  });

  it('Backspace at the start of a source neither unindents nor turns it into a paragraph', () => {
    const { editor } = open([
      { type: 'bulletListItem', content: 'item', children: [{ type: 'mathBlock', content: 'x+1' }] },
    ]);
    openPopupAtStart(editor);
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Backspace')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(blocks(editor)[0]!.children[0]!.type).toBe('mathBlock');
  });

  it('Delete at the end of a source does nothing to the line below', () => {
    const { editor } = open([
      { type: 'mathBlock', content: 'abc' },
      { type: 'paragraph', content: 'tail' },
    ]);
    const id = openPopupAtStart(editor);
    const at = posOf(editor, 'mathBlock');
    select(editor, at + editor.prosemirrorView!.state.doc.nodeAt(at)!.nodeSize - 1);
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, 'Delete')).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(popupOpen(editor, id)).toBe(true);
  });

  it('Backspace in an empty source deletes the formula block', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', content: '' },
    ]);
    openPopupAtStart(editor);

    expect(press(editor, 'Backspace')).toBe(true);

    expect(blocks(editor).map((block) => block.type)).toEqual(['paragraph']);
  });

  it.each([
    ['Backspace after its last character', 'Backspace', 1, 1],
    ['Delete before its last character', 'Delete', 1, 0],
    ['Backspace over the whole source selected', 'Backspace', 3, 0],
  ] as const)('%s empties the source itself and keeps the caret in it', (_label, key, length, offset) => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', content: 'abc'.slice(0, length) },
    ]);
    const id = openPopupAtStart(editor);
    const start = posOf(editor, 'mathBlock') + 1;
    if (length === 1) select(editor, start + offset);
    else select(editor, start, start + length);

    expect(press(editor, key)).toBe(true);

    expect(blocks(editor).map((block) => block.type)).toEqual(['paragraph', 'mathBlock']);
    const { $from, empty } = editor.prosemirrorView!.state.selection;
    expect(empty).toBe(true);
    expect($from.parent.type.name).toBe('mathBlock');
    expect($from.parent.content.size).toBe(0);
    expect(popupOpen(editor, id)).toBe(true);

    type(editor, 'yz');
    expect(editor.prosemirrorView!.state.doc.nodeAt(posOf(editor, 'mathBlock'))!.textContent).toBe('yz');
  });

  it.each([
    ['Backspace', 'above'],
    ['Delete', 'child one'],
  ])('%s in an empty source keeps the lines indented under the formula', (key, caretIn) => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      {
        type: 'mathBlock',
        content: '',
        children: [
          { type: 'paragraph', content: 'child one' },
          { type: 'paragraph', content: 'child two' },
        ],
      },
      { type: 'paragraph', content: 'tail' },
    ]);
    openPopupAtStart(editor);

    expect(press(editor, key)).toBe(true);

    expect(shape(editor)).toEqual(['paragraph:above', 'paragraph:child one', 'paragraph:child two', 'paragraph:tail']);
    const { $from } = editor.prosemirrorView!.state.selection;
    expect($from.parent.textContent).toBe(caretIn);
    expect($from.parentOffset).toBe(key === 'Backspace' ? caretIn.length : 0);
  });
});

describe('a line beside a closed block formula (A7)', () => {
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

  it.each([
    ['Backspace at the start of the line below', 'Backspace', 'below'],
    ['Delete at the end of the line above', 'Delete', 'above'],
  ] as const)('%s selects the formula, and the next press deletes it', (_label, key, line) => {
    const { editor } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', content: 'x+1' },
      { type: 'paragraph', content: 'below' },
    ]);
    const id = blocks(editor)[1]!.id;
    select(editor, line === 'below' ? positionOf(editor, 'below', 0) : positionOf(editor, 'above', 5));
    const before = editor.prosemirrorView!.state.doc;

    expect(press(editor, key)).toBe(true);

    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.prosemirrorView!.state.selection.$from.parent.type.name).toBe('mathBlock');
    expect(popupOpen(editor, id)).toBe(false);

    keyDown(editor, key);

    expect(shape(editor)).toEqual(['paragraph:above', 'paragraph:below']);
  });
});

describe('Enter at a formula where our own Enter handler sits first (A5)', () => {
  it.each([
    ['a quoted paragraph', between('xy', { quoted: true })],
    ['a list item', { ...between('xy'), type: 'bulletListItem' }],
  ])('inside an inline source in %s, confirms without splitting the block', (_label, block) => {
    const { editor } = open([block]);
    select(editor, source(editor).end);

    expect(press(editor, 'Enter')).toBe(true);

    expect(blocks(editor)).toHaveLength(1);
    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).after);
  });

  it('on a selected block formula in a quote, opens the popup without splitting', () => {
    const { editor } = open([{ type: 'mathBlock', props: { quoted: true }, content: 'x' }]);
    const { id } = blocks(editor)[0]!;
    editor.setTextCursorPosition(id, 'end');

    expect(press(editor, 'Enter')).toBe(true);

    expect(blocks(editor)).toHaveLength(1);
    expect(blocks(editor)[0]!.type).toBe('mathBlock');
    expect(popupOpen(editor, id)).toBe(true);
  });
});

describe('Mod-a inside an inline source (6.2)', () => {
  it('selects the source alone', () => {
    const { editor } = open([between('xy')], { extensions: [documentSelectAllExtension(null)] });
    select(editor, source(editor).start + 1);

    expect(press(editor, 'a', true)).toBe(true);

    const { from, to } = editor.prosemirrorView!.state.selection;
    expect([from, to]).toEqual([source(editor).start, source(editor).end]);
  });
});

describe('the arrow keys at an inline formula’s edges (A7)', () => {
  it('ArrowRight at the end of its source puts the caret right after the formula', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).end);

    expect(press(editor, 'ArrowRight')).toBe(true);

    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).after);
  });

  it('ArrowLeft at the start of its source puts the caret right before the formula', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).start);

    expect(press(editor, 'ArrowLeft')).toBe(true);

    expect(editor.prosemirrorView!.state.selection.from).toBe(posOf(editor, 'math'));
  });

  it('ArrowLeft right after the formula puts the caret at the end of its source', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).after);

    expect(press(editor, 'ArrowLeft')).toBe(true);

    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).end);
  });

  it('ArrowRight right before the formula puts the caret at the start of its source', () => {
    const { editor } = open([between('xy')]);
    select(editor, posOf(editor, 'math'));

    expect(press(editor, 'ArrowRight')).toBe(true);

    expect(editor.prosemirrorView!.state.selection.from).toBe(source(editor).start);
  });

  it('leaves an arrow inside the source to the browser', () => {
    const { editor } = open([between('xy')]);
    select(editor, source(editor).start + 1);

    expect(press(editor, 'ArrowRight')).toBe(false);
    expect(press(editor, 'ArrowLeft')).toBe(false);
  });
});
