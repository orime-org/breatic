// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T14: a selection with one end in a table and the other outside
 * it takes the whole table, and typing or deleting over it takes the table
 * away whole, never cutting it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/** A 2 × 2 table of words. */
const WORDS: TableInput = { rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] };

/**
 * A mounted editor holding a line, a table and a line, with an undo manager.
 * @param table - The table.
 * @returns The editor and its undo manager.
 */
function open(table: TableInput = WORDS): { editor: Editor; manager: Y.UndoManager } {
  return openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(table), { type: 'paragraph', content: 'below' }]);
}

/**
 * A mounted editor holding some blocks, with an undo manager.
 * @param content - The blocks.
 * @returns The editor and its undo manager.
 */
function openWith(content: unknown[]): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, content as never);
  manager.stopCapturing();
  editor.prosemirrorView.focus();
  return { editor, manager };
}

/**
 * A position in some words.
 * @param editor - The editor.
 * @param words - The words.
 * @param offset - How far into them.
 * @returns The position.
 */
function at(editor: Editor, words: string, offset: number): number {
  let found = -1;
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === words) found = pos + offset;
    return found < 0;
  });
  return found;
}

/**
 * Selects from one position to another.
 * @param editor - The editor.
 * @param anchor - Where it starts.
 * @param head - Where it ends.
 */
function select(editor: Editor, anchor: number, head: number): void {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
}

/**
 * The top-level blocks as `type:words`.
 * @param editor - The editor.
 * @returns One entry per block.
 */
function blocks(editor: Editor): string[] {
  return (editor.document as unknown as { type: string }[]).map((block) => {
    const words = (block as { content?: { text?: string }[] }).content;
    return Array.isArray(words) ? `${block.type}:${words.map((w) => w.text ?? '').join('')}` : block.type;
  });
}

/**
 * Presses a key through the editor's own handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @param shiftKey - Whether Shift is held.
 */
function press(editor: Editor, key: string, shiftKey = false): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (f) => f(view, event));
}

/**
 * Types through the editor's text input handlers, as a key press over a
 * selection across blocks does.
 * @param editor - The editor.
 * @param text - What is typed.
 */
function type(editor: Editor, text: string): void {
  const view = editor.prosemirrorView;
  const { from, to } = view.state.selection;
  const fallback = (): ReturnType<typeof view.state.tr.insertText> => view.state.tr.insertText(text);
  if (!view.someProp('handleTextInput', (f) => f(view, from, to, text, fallback))) view.dispatch(fallback());
}

describe('a selection leaving a table', () => {
  it('takes the whole table when it runs from a cell to below the table', () => {
    const { editor } = open();
    const head = at(editor, 'below', 2);

    select(editor, at(editor, 'b1', 1), head);

    const { anchor, head: now } = editor.prosemirrorView.state.selection;
    expect(anchor).toBe(at(editor, 'a1', 0));
    expect(now).toBe(head);
  });

  it('takes the whole table when it runs backwards from below into a cell', () => {
    const { editor } = open();
    const anchor = at(editor, 'below', 2);

    select(editor, anchor, at(editor, 'b1', 1));

    const { anchor: now, head } = editor.prosemirrorView.state.selection;
    expect(now).toBe(anchor);
    expect(head).toBe(at(editor, 'a1', 0));
  });

  it('takes the whole table when it runs from above into a cell', () => {
    const { editor } = open();
    const anchor = at(editor, 'lead', 2);

    select(editor, anchor, at(editor, 'a2', 1));

    const { anchor: now, head } = editor.prosemirrorView.state.selection;
    expect(now).toBe(anchor);
    expect(head).toBe(at(editor, 'b2', 2));
  });

  it('is left to the table when both ends are in it', () => {
    const { editor } = open();
    const anchor = at(editor, 'a1', 1);
    const head = at(editor, 'b2', 1);

    select(editor, anchor, head);

    const { anchor: a, head: h } = editor.prosemirrorView.state.selection;
    expect([a, h]).not.toEqual([at(editor, 'a1', 0), at(editor, 'b2', 2)]);
  });

  it('stays in the table when the table does not start with words', () => {
    const { editor } = open({
      rows: [{ cells: [{ blocks: [{ type: 'divider' }, { type: 'paragraph', content: 'a1' }] } as never, 'b1'] }],
    });

    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    expect(editor.prosemirrorView.state.selection.from).toBe(at(editor, 'a1', 0));
  });

  it('draws every cell of the table as selected', () => {
    const { editor } = open();

    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    const cells = [...editor.prosemirrorView.dom.querySelectorAll('td, th')];
    expect(cells.length).toBe(4);
    expect(cells.every((cell) => cell.classList.contains('doc-table-in-selection'))).toBe(true);
  });
});

describe('deleting or typing over a selection leaving a table', () => {
  it('takes the table away whole with Backspace, and one undo brings it back', () => {
    const { editor, manager } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    press(editor, 'Backspace');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:low']);
    manager.undo();
    expect(blocks(editor)).toEqual(['paragraph:lead', 'docTable', 'paragraph:below']);
    expect(editor.prosemirrorView.state.doc.textContent).toBe('leada1b1a2b2below');
  });

  it('brings the table back with its words in one undo after a typed key', () => {
    const { editor, manager } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    type(editor, 'X');
    manager.undo();

    expect(blocks(editor)).toEqual(['paragraph:lead', 'docTable', 'paragraph:below']);
    expect(editor.prosemirrorView.state.doc.textContent).toBe('leada1b1a2b2below');
  });

  it('takes the table away whole when a key is typed, the letter in its place', () => {
    const { editor } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:Xlow']);
  });

  it('takes the table away whole when an input method starts composing over it', () => {
    const { editor } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    // This plugin's own handler, run as ProseMirror runs it ahead of its
    // own: by the time the browser composes, the selection has to be gone.
    // The other plugins' handlers stay out: one keeps a composition flag at
    // module level (`prosemirror-safari-ime-span`) that no end would clear.
    const view = editor.prosemirrorView;
    const plugin = view.state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith('documentTableLeaveSelection'))!;
    plugin.props.handleDOMEvents?.compositionstart?.call(plugin, view, new CompositionEvent('compositionstart'));

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:low']);
  });

  it('takes the table away whole when something is pasted over it, the paste in its place', () => {
    const { editor } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    editor.prosemirrorView.pasteText('PASTED');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:PASTEDlow']);
  });

  it('takes both tables away whole when it runs from one table into another', () => {
    const { editor } = openWith([
      { type: 'paragraph', content: 'lead' },
      tableBlock(WORDS),
      { type: 'paragraph', content: 'mid' },
      tableBlock({ rows: [{ cells: ['c1', 'd1'] }] }),
      { type: 'paragraph', content: 'end' },
    ]);
    select(editor, at(editor, 'b1', 1), at(editor, 'c1', 1));

    press(editor, 'Backspace');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:end']);
  });

  it('takes a table that opens the body away whole, though it does not start with words', () => {
    const { editor } = openWith([
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'divider' }, { type: 'paragraph', content: 'a1' }] } as never, 'b1'] }] }),
      { type: 'paragraph', content: 'below' },
    ]);
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    press(editor, 'Backspace');

    expect(blocks(editor)).toEqual(['paragraph:low']);
  });

  it('leaves a block above the table that the selection does not reach', () => {
    const { editor } = openWith([
      { type: 'paragraph', content: 'lead' },
      { type: 'divider' },
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'divider' }, { type: 'paragraph', content: 'a1' }] } as never, 'b1'] }] }),
      { type: 'paragraph', content: 'below' },
    ]);
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    press(editor, 'Backspace');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'divider', 'paragraph:low']);
  });

  it('takes the table away whole when typing over a selection from above into it', () => {
    const { editor } = open();
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:leX', 'paragraph:below']);
  });
});

describe('Shift and an arrow at a table\'s edge', () => {
  it('runs the selection from the last row down below the table, the whole table with it', () => {
    const { editor } = open();
    editor.prosemirrorView.endOfTextblock = (): boolean => true;
    select(editor, at(editor, 'b2', 2), at(editor, 'b2', 2));

    press(editor, 'ArrowDown', true);

    const { anchor, head } = editor.prosemirrorView.state.selection;
    expect(anchor).toBe(at(editor, 'a1', 0));
    expect(head).toBe(at(editor, 'below', 0));
  });

  it('runs the selection from the first row up above the table, the whole table with it', () => {
    const { editor } = open();
    editor.prosemirrorView.endOfTextblock = (): boolean => true;
    select(editor, at(editor, 'a1', 0), at(editor, 'a1', 0));

    press(editor, 'ArrowUp', true);

    const { anchor, head } = editor.prosemirrorView.state.selection;
    expect(anchor).toBe(at(editor, 'b2', 2));
    expect(head).toBe(at(editor, 'lead', 4));
  });

  it('takes the selection back over the whole table with Shift and the opposite arrow', () => {
    const { editor } = open();
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    press(editor, 'ArrowUp', true);

    const { selection } = editor.prosemirrorView.state;
    expect(selection).not.toBeInstanceOf(CellSelection);
    expect([selection.anchor, selection.head]).toEqual([at(editor, 'lead', 2), at(editor, 'lead', 4)]);
  });

  it('leaves Shift and an arrow on an inner row to the table', () => {
    const { editor } = open();
    editor.prosemirrorView.endOfTextblock = (): boolean => true;
    select(editor, at(editor, 'a1', 1), at(editor, 'a1', 1));

    press(editor, 'ArrowDown', true);

    expect(editor.prosemirrorView.state.selection.head).not.toBe(at(editor, 'below', 0));
  });
});
