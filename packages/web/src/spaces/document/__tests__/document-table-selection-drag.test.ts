// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A8 (design §5.7): what a pulled selection shows is what it
 * keeps, across tables. prosemirror-tables narrows a text selection only
 * between two cells of one table; a drag that started in a cell and left the
 * table becomes a text selection from the press to the pointer, and a cell
 * selection again when the pointer is back on another cell; and while a cell
 * selection stands the body draws no native selection, only its cells.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, tableEditingKey } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
/** Presses a case made: let go before the next case, or prosemirror-tables keeps listening for their moves. */
const held: Array<{ release: () => void }> = [];

afterEach(() => {
  for (const pull of held.splice(0)) pull.release();
  vi.restoreAllMocks();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding a paragraph, a 2 × 2 table and a paragraph.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
    tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
    { type: 'paragraph', content: 'below' },
  ] as never);
  return editor;
}

/**
 * Where a run of text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns Its position.
 */
function textPos(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text "${text}"`);
  return at;
}

/**
 * Sets a text selection the way the browser's would arrive.
 * @param editor - The editor.
 * @param anchor - Its anchor.
 * @param head - Its head.
 */
function select(editor: Editor, anchor: number, head: number): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
}

describe('prosemirror-tables narrowing a text selection (patched)', () => {
  it('leaves a selection from above the table to the start of a cell as it is', () => {
    const editor = open();
    select(editor, textPos(editor, 'above') + 2, textPos(editor, 'b1'));
    const { selection } = editor.prosemirrorState;
    expect([selection.from, selection.to]).toEqual([textPos(editor, 'above') + 2, textPos(editor, 'b1')]);
  });

  it('still narrows one from a cell to the start of another cell of the same table', () => {
    const editor = open();
    select(editor, textPos(editor, 'a1') + 1, textPos(editor, 'b1'));
    const { selection } = editor.prosemirrorState;
    expect(selection.$to.parent.textContent).toBe('a1');
  });
});

/**
 * Where each test-placed element is, for the stubbed hit test.
 */
interface Spot {
  element: Element;
  pos: number;
}

/**
 * A press and the moves after it, with the hit test stubbed: the body has no
 * layout in a test page, so each event's x is the index of the spot it is over.
 */
class Pull {
  private readonly spots: Spot[] = [];

  /**
   * Presses in a cell.
   * @param editor - The editor.
   * @param at - Where.
   */
  constructor(private readonly editor: Editor, at: Spot) {
    const view = editor.prosemirrorView!;
    vi.spyOn(view, 'posAtCoords').mockImplementation(({ left }) => {
      const spot = this.spots[left];
      return spot === undefined ? null : { pos: spot.pos, inside: -1 };
    });
    this.spots.push(at);
    held.push(this);
    at.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 0 }));
  }

  /**
   * Moves the pointer over a spot, the button held.
   * @param at - Where.
   * @returns This pull.
   */
  to(at: Spot): this {
    this.spots.push(at);
    at.element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: this.spots.length - 1 }));
    return this;
  }

  /** Lets go. */
  release(): void {
    this.editor.prosemirrorView!.root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }
}

/**
 * A cell's element and a position inside its text.
 * @param editor - The editor.
 * @param text - The cell's text.
 * @returns The spot.
 */
function cell(editor: Editor, text: string): Spot {
  const pos = textPos(editor, text) + 1;
  const element = editor.prosemirrorView!.domAtPos(pos).node.parentElement!.closest('td')!;
  return { element, pos };
}

/**
 * A paragraph's element and a position inside it.
 * @param editor - The editor.
 * @param text - The paragraph's text.
 * @returns The spot.
 */
function paragraph(editor: Editor, text: string): Spot {
  const pos = textPos(editor, text) + 1;
  const element = editor.prosemirrorView!.domAtPos(pos).node.parentElement!;
  return { element, pos };
}

describe('pulling from a cell out of the table (patched)', () => {
  it('lets go of the cell selection when the pointer leaves the table, so the page selection is read', () => {
    const editor = open();
    const pull = new Pull(editor, cell(editor, 'a1')).to(cell(editor, 'b1'));
    expect(editor.prosemirrorState.selection).toBeInstanceOf(CellSelection);
    expect(tableEditingKey.getState(editor.prosemirrorState)).not.toBe(null);
    pull.to(paragraph(editor, 'below'));
    expect(tableEditingKey.getState(editor.prosemirrorState)).toBe(null);
    pull.release();
  });

  it('makes no one-cell cell selection when the pointer goes straight from the pressed cell out of the table', () => {
    const editor = open();
    const pull = new Pull(editor, cell(editor, 'a1')).to(paragraph(editor, 'below'));
    expect(editor.prosemirrorState.selection).not.toBeInstanceOf(CellSelection);
    expect(tableEditingKey.getState(editor.prosemirrorState)).toBe(null);
    pull.release();
  });

  it('becomes a cell selection again when the pointer is back on another cell', () => {
    const editor = open();
    const pull = new Pull(editor, cell(editor, 'a1')).to(cell(editor, 'b1')).to(paragraph(editor, 'below')).to(cell(editor, 'b2'));
    const { selection } = editor.prosemirrorState;
    pull.release();
    expect(selection).toBeInstanceOf(CellSelection);
    expect((selection as CellSelection).$headCell.nodeAfter?.textContent).toBe('b2');
  });
});

describe('the body while a cell selection stands', () => {
  it('carries the mark that keeps the native selection from being drawn, and drops it after', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    new Pull(editor, cell(editor, 'a1')).to(cell(editor, 'b2')).release();
    expect(view.dom.hasAttribute('data-selection-drawn')).toBe(true);
    select(editor, textPos(editor, 'below') + 1, textPos(editor, 'below') + 1);
    expect(view.dom.hasAttribute('data-selection-drawn')).toBe(false);
  });
});
