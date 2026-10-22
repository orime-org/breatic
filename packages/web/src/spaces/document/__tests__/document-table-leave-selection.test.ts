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
import { extendToBodyEdge } from '@web/spaces/document/document-body-edge-selection';
import { tableClipped } from '@web/spaces/document/document-table-copy';
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

    const { anchor, head } = editor.prosemirrorView.state.selection;
    expect(Math.min(anchor, head)).toBe(at(editor, 'a1', 0));
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

    // Each table gives way to an empty line, and the two join, as two empty
    // lines selected across do in the body.
    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:', 'paragraph:end']);
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

  it('leaves the line a selection ends at the end of, the typed key on it, the next line untouched', () => {
    const { editor } = openWith([
      { type: 'paragraph', content: 'lead' },
      tableBlock(WORDS),
      { type: 'paragraph', content: 'below' },
      { type: 'paragraph', content: 'next' },
    ]);
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 5));

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:X', 'paragraph:next']);
  });

  it('puts pasted lines where the selection was, as at the start of a line in the body', () => {
    const { editor } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    editor.prosemirrorView.pasteHTML('<p>X1</p><p>X2</p>');

    // Pasting lines at the start of a line leaves an empty line before them
    // in the body too.
    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:', 'paragraph:X1', 'paragraph:X2low']);
  });

  it('takes the table away whole when a table from another app is pasted over a selection ending in it', () => {
    const { editor } = open();
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));
    const view = editor.prosemirrorView;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    const data: Record<string, string> = { 'text/html': '<table><tr><td>P1</td><td>P2</td></tr></table>' };
    Object.defineProperty(event, 'clipboardData', {
      value: { types: Object.keys(data), files: [], items: [], getData: (format: string) => data[format] ?? '' },
    });

    view.dom.dispatchEvent(event);

    expect(view.state.doc.textContent).toBe('leP1P2below');
  });

  it('takes the table away whole with Enter, the line split where the selection was', () => {
    const { editor } = openWith([
      { type: 'paragraph', content: 'lead' },
      tableBlock(WORDS),
      { type: 'paragraph', content: 'below' },
      { type: 'paragraph', content: 'next' },
    ]);
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 3));

    press(editor, 'Enter');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:', 'paragraph:ow', 'paragraph:next']);
  });

  it.each([
    ['Option+Backspace', { key: 'Backspace', altKey: true }],
    ['Ctrl+H', { key: 'h', ctrlKey: true }],
    ['Mod+Delete (Ctrl outside macOS)', { key: 'Delete', ctrlKey: true }],
  ] as const)('takes the table away whole with %s, the word and line deletes', (_name, init) => {
    const { editor } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));
    const view = editor.prosemirrorView;

    const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
    view.someProp('handleKeyDown', (f) => f(view, event));

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:low']);
  });

  it('takes a divider between the table and the selection\'s end away with it, below the table', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'divider' }, { type: 'paragraph', content: 'below' }]);
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    press(editor, 'Backspace');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:low']);
  });

  it('takes a divider between the selection\'s start and the table away with it, above the table', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, { type: 'divider' }, tableBlock(WORDS), { type: 'paragraph', content: 'below' }]);
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:leX', 'paragraph:below']);
  });

  it('leaves the table when a paste brings nothing to paste', () => {
    const { editor } = open();
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { types: [], files: [], items: [], getData: () => '' } });

    editor.prosemirrorView.dom.dispatchEvent(event);

    expect(blocks(editor)).toEqual(['paragraph:lead', 'docTable', 'paragraph:below']);
  });

  it('takes the table away whole when the browser deletes a word or a line over it', () => {
    const { editor } = open();
    select(editor, at(editor, 'b1', 1), at(editor, 'below', 2));

    editor.prosemirrorView.dom.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteWordBackward', bubbles: true, cancelable: true }));

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:low']);
  });

  it('takes the table away whole from a selection run from a cell to the end of the body', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'paragraph' }]);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(extendToBodyEdge(view.state.doc, at(editor, 'a2', 1), 'end')));
    expect([...view.dom.querySelectorAll('td, th')].every((cell) => cell.classList.contains('doc-table-in-selection'))).toBe(true);

    press(editor, 'Backspace');

    expect(blocks(editor).filter((b) => b === 'docTable')).toEqual([]);
    expect(blocks(editor)[0]).toBe('paragraph:lead');
  });

  it('takes the table away whole when typing over a selection from above into it', () => {
    const { editor } = open();
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:leX', 'paragraph:below']);
  });
});

/**
 * Dispatches a cut, the way the browser hands one to the body.
 * @param editor - The editor.
 * @returns What went on the clipboard.
 */
function cut(editor: Editor): Record<string, string> {
  const data: Record<string, string> = {};
  const event = new Event('cut', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (format: string, value: string) => {
        data[format] = value;
      },
      clearData: () => undefined,
      getData: (format: string) => data[format] ?? '',
    },
  });
  editor.prosemirrorView.dom.dispatchEvent(event);
  return data;
}

/**
 * Selects from some words to an edge of the body.
 * @param editor - The editor.
 * @param anchor - Where it starts.
 * @param edge - Which edge.
 */
function selectToEdge(editor: Editor, anchor: number, edge: 'start' | 'end'): void {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(extendToBodyEdge(view.state.doc, anchor, edge)));
}

describe('a selection from a cell to an edge of the body', () => {
  /** A line, a table and an empty last line. */
  const tableThenEmpty = (): unknown[] => [{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'paragraph' }];

  it('takes the table away whole when cut, the whole table on the clipboard', () => {
    const { editor } = openWith(tableThenEmpty());
    selectToEdge(editor, at(editor, 'a2', 1), 'end');

    const clipboard = cut(editor);

    expect(clipboard['text/html']).toContain('<table');
    expect(blocks(editor).filter((block) => block === 'docTable')).toEqual([]);
  });

  it('takes the table away whole with Enter', () => {
    const { editor } = openWith(tableThenEmpty());
    selectToEdge(editor, at(editor, 'a2', 1), 'end');

    press(editor, 'Enter');

    expect(blocks(editor).filter((block) => block === 'docTable')).toEqual([]);
  });

  it('takes the table away whole when a drag of it moves it', () => {
    const { editor } = openWith(tableThenEmpty());
    selectToEdge(editor, at(editor, 'a2', 1), 'end');
    const view = editor.prosemirrorView;

    // What prosemirror-view's drop does with the source of a move.
    view.dispatch(view.state.tr.deleteSelection());

    expect(blocks(editor).filter((block) => block === 'docTable')).toEqual([]);
  });

  it('takes a table that opens the body away whole when typing over a selection from below to the start', () => {
    const { editor } = openWith([tableBlock(WORDS), { type: 'paragraph', content: 'below' }]);
    selectToEdge(editor, at(editor, 'below', 2), 'start');
    expect([...editor.prosemirrorView.dom.querySelectorAll('td')].every((cell) => cell.classList.contains('doc-table-in-selection'))).toBe(true);

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:Xlow']);
  });

  it('takes a table that closes the body away whole from a cell to the end', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS)]);
    selectToEdge(editor, at(editor, 'a2', 1), 'end');

    press(editor, 'Backspace');

    expect(blocks(editor).filter((block) => block === 'docTable')).toEqual([]);
    expect(blocks(editor)[0]).toBe('paragraph:lead');
  });
});

describe('what is left where a held table stood, as the body leaves it', () => {
  it('puts a key typed over a selection from one table to another on a line of its own', () => {
    const { editor } = openWith([
      { type: 'heading', content: 'Title' },
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }] }),
      { type: 'paragraph', content: 'mid' },
      tableBlock({ rows: [{ cells: ['c1', 'd1'] }] }),
      { type: 'paragraph', content: 'end' },
    ]);
    select(editor, at(editor, 'a1', 1), at(editor, 'd1', 1));

    type(editor, 'Z');

    expect(blocks(editor)).toEqual(['heading:Title', 'paragraph:Z', 'paragraph:end']);
  });

  it('puts a key typed over a selection from a cell to the end of the body on a line of its own', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'divider' }]);
    selectToEdge(editor, at(editor, 'a2', 1), 'end');

    type(editor, 'X');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:X']);
  });

  it('leaves what the body leaves for a selection from an empty line into a nested line, the list item above gone', () => {
    const nested = { type: 'bulletListItem', content: 'Aitem', children: [{ type: 'bulletListItem', content: 'Bchild' }] };
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), nested]);
    select(editor, at(editor, 'b2', 1), at(editor, 'Bchild', 3));
    press(editor, 'Backspace');
    const body = openWith([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }, nested]).editor;
    const line = at(body, 'lead', 4) + 4;
    select(body, line, at(body, 'Bchild', 3));
    press(body, 'Backspace');

    expect(editor.prosemirrorView.state.doc.toString()).toBe(body.prosemirrorView.state.doc.toString());
    expect(editor.prosemirrorView.state.doc.textContent).toBe('leadild');
  });

  it('leaves the caret where the body does after Backspace over a selection from a cell to the start of the body', () => {
    const { editor } = openWith([{ type: 'divider' }, tableBlock(WORDS), { type: 'paragraph', content: 'tail' }]);
    selectToEdge(editor, at(editor, 'b2', 1), 'start');
    press(editor, 'Backspace');
    const body = openWith([{ type: 'divider' }, { type: 'paragraph' }, { type: 'paragraph', content: 'tail' }]).editor;
    selectToEdge(body, at(body, 'tail', 0) - 4, 'start');
    press(body, 'Backspace');

    expect(editor.prosemirrorView.state.doc.toString()).toBe(body.prosemirrorView.state.doc.toString());
    expect(editor.prosemirrorView.state.selection.head).toBe(body.prosemirrorView.state.selection.head);
  });

  it('puts a key typed over a selection from a cell to the start of the body on a line of its own, as the body does', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'paragraph', content: 'tail' }]);
    selectToEdge(editor, at(editor, 'b2', 1), 'start');

    type(editor, 'Z');

    expect(blocks(editor)).toEqual(['paragraph:Z', 'paragraph:tail']);
  });

  it('leaves the caret where the body does after Backspace over a selection from a cell to the start of a nested line', () => {
    const nested = { type: 'bulletListItem', content: 'two', children: [{ type: 'paragraph', content: 'kid' }] };
    const { editor } = openWith([{ type: 'paragraph', content: 'one' }, tableBlock(WORDS), nested]);
    select(editor, at(editor, 'a1', 1), at(editor, 'kid', 0));
    press(editor, 'Backspace');
    const body = openWith([{ type: 'paragraph', content: 'one' }, { type: 'paragraph' }, nested]).editor;
    select(body, at(body, 'one', 3) + 4, at(body, 'kid', 0));
    press(body, 'Backspace');

    expect(editor.prosemirrorView.state.doc.toString()).toBe(body.prosemirrorView.state.doc.toString());
    expect(editor.prosemirrorView.state.selection.head).toBe(body.prosemirrorView.state.selection.head);
  });

  it('types a plain key, as the body does, over a selection from a cell below the table whose first words are bold', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    const a1 = at(editor, 'a1', 0);
    view.dispatch(view.state.tr.addMark(a1, a1 + 2, view.state.schema.marks['bold']!.create()));
    select(editor, at(editor, 'b2', 1), at(editor, 'below', 2));

    type(editor, 'Z');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:Zlow']);
    let bold = false;
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'bold')) bold = true;
      return true;
    });
    expect(bold).toBe(false);
  });

  it('makes the line a key is typed on a paragraph, as the body does, over a selection from a cell into a heading', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'heading', content: 'head' }]);
    select(editor, at(editor, 'a1', 1), at(editor, 'head', 2));

    type(editor, 'Z');

    expect(blocks(editor)).toEqual(['paragraph:lead', 'paragraph:Zad']);
  });

  it('leaves no empty line under a list item whose nested table is taken away', () => {
    const { editor } = openWith([
      { type: 'paragraph', content: 'lead' },
      { type: 'bulletListItem', content: 'Item', children: [tableBlock(WORDS)] },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(editor, at(editor, 'b1', 1), at(editor, 'tail', 2));

    press(editor, 'Backspace');

    expect(editor.prosemirrorView.state.doc.textContent).toBe('leadItemil');
    let empty = 0;
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.isTextblock && node.content.size === 0) empty += 1;
      return true;
    });
    expect(empty).toBe(0);
  });
});

describe('keys over a held table', () => {
  it('opens the lines Enter opens as the body does, the table taken away first', () => {
    const quotedLead = { type: 'paragraph', props: { quoted: true }, content: 'lead' };
    // The table's first cell quoted: Enter must not judge the quote from it.
    const quotedCell = { rows: [{ cells: [{ blocks: [{ type: 'paragraph', props: { quoted: true }, content: 'a1' }] } as never, 'b1'] }] };
    const { editor } = openWith([quotedLead, tableBlock(quotedCell), { type: 'paragraph', content: 'below' }]);
    select(editor, at(editor, 'lead', 2), at(editor, 'b1', 1));
    press(editor, 'Enter');
    const body = openWith([quotedLead, { type: 'paragraph' }, { type: 'paragraph', content: 'below' }]).editor;
    select(body, at(body, 'lead', 2), at(body, 'lead', 4) + 4);
    press(body, 'Enter');

    expect(editor.prosemirrorView.state.doc.toString()).toBe(body.prosemirrorView.state.doc.toString());
  });

  it('leaves the selection as it is with Shift and an arrow when the table closes the body', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS)]);
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));
    const before = editor.prosemirrorView.state.selection;

    press(editor, 'ArrowDown', true);

    const after = editor.prosemirrorView.state.selection;
    expect([after.anchor, after.head]).toEqual([before.anchor, before.head]);
  });

  it('adds no row with Tab', () => {
    const { editor } = open();
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    press(editor, 'Tab');

    let rows = 0;
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name === 'docTableRow') rows += 1;
      return true;
    });
    expect(rows).toBe(2);
  });
});

describe('copying a selection leaving a table', () => {
  it('carries the blocks at the table\'s edges that are not words', () => {
    const { editor } = open({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', { blocks: [{ type: 'paragraph', content: 'b2' }, { type: 'divider' }] } as never] }] });
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    const clipped = tableClipped(editor as never, editor.prosemirrorView);

    expect(clipped?.external).toContain('<hr');
  });

  it('drags the whole table, the blocks at its edges that are not words included', () => {
    const { editor } = open({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', { blocks: [{ type: 'paragraph', content: 'b2' }, { type: 'divider' }] } as never] }] });
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));
    const view = editor.prosemirrorView;

    const { slice } = view.serializeForClipboard(view.state.selection.content());

    const types: string[] = [];
    slice.content.descendants((node) => {
      types.push(node.type.name);
      return true;
    });
    expect(types).toContain('divider');
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

  it('runs the selection over the table to the end of the body when only a divider is past it', () => {
    const { editor } = openWith([{ type: 'paragraph', content: 'lead' }, tableBlock(WORDS), { type: 'divider' }]);
    select(editor, at(editor, 'lead', 2), at(editor, 'a2', 1));

    press(editor, 'ArrowDown', true);

    const { selection, doc } = editor.prosemirrorView.state;
    expect(selection.head).toBe(doc.content.size - 2);
  });

  it('leaves Shift and an arrow on an inner row to the table', () => {
    const { editor } = open();
    editor.prosemirrorView.endOfTextblock = (): boolean => true;
    select(editor, at(editor, 'a1', 1), at(editor, 'a1', 1));

    press(editor, 'ArrowDown', true);

    expect(editor.prosemirrorView.state.selection.head).not.toBe(at(editor, 'below', 0));
  });
});
