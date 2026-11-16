// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1314 design §5.1 entry table: moving blocks from the keyboard in and
 * around columns. A block moves within its column and stays at the column's
 * top or bottom; a block of the body passes a column group as one block; a
 * selection that runs across columns, or into a group from outside, carries
 * the whole group.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { dropRowBeside } from '@web/spaces/document/document-column-drop';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where a text starts.
 * @param editor - The editor.
 * @param words - The text.
 * @returns Its position.
 */
function at(editor: Editor, words: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === words) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${words}"`);
  return found;
}

/**
 * Selects from the start of one text to the end of another.
 * @param editor - The editor.
 * @param from - The first text.
 * @param to - The last text.
 */
function select(editor: Editor, from: string, to: string): void {
  const view = editor.prosemirrorView;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, at(editor, from), at(editor, to) + to.length)),
  );
}

/**
 * Presses the move shortcut.
 * @param editor - The editor.
 * @param key - Which way.
 */
function move(editor: Editor, key: 'ArrowUp' | 'ArrowDown'): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, shiftKey: true, ctrlKey: true, bubbles: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
}

/**
 * The body's shape.
 * @param editor - The editor.
 * @returns See `shapeOf`.
 */
function shape(editor: Editor): string[] {
  return shapeOf(editor.document as never);
}

describe('moving blocks in and around columns', () => {
  it('moves a block within its column', () => {
    const editor = open([columnsBlock(['a', 'b'], ['c'])]);
    select(editor, 'b', 'b');
    move(editor, 'ArrowUp');
    expect(shape(editor)).toEqual(['[b,a|c]']);
  });

  it('keeps a block at the top of its column where it is', () => {
    const editor = open([para('lead'), columnsBlock(['a', 'b'], ['c'])]);
    select(editor, 'c', 'c');
    move(editor, 'ArrowUp');
    expect(shape(editor)).toEqual(['lead', '[a,b|c]']);
  });

  it('keeps a block at the bottom of its column where it is', () => {
    const editor = open([columnsBlock(['a', 'b'], ['c']), para('tail')]);
    select(editor, 'b', 'b');
    move(editor, 'ArrowDown');
    expect(shape(editor)).toEqual(['[a,b|c]', 'tail']);
  });

  it('moves a block below the group up past the whole group', () => {
    const editor = open([para('lead'), columnsBlock(['a'], ['c']), para('tail')]);
    select(editor, 'tail', 'tail');
    move(editor, 'ArrowUp');
    expect(shape(editor)).toEqual(['lead', 'tail', '[a|c]']);
  });

  it('moves a block above the group down past the whole group', () => {
    const editor = open([para('lead'), columnsBlock(['a'], ['c']), para('tail')]);
    select(editor, 'lead', 'lead');
    move(editor, 'ArrowDown');
    expect(shape(editor)).toEqual(['[a|c]', 'lead', 'tail']);
  });

  it('carries the whole group when the selection runs across its columns', () => {
    const editor = open([para('lead'), columnsBlock(['a'], ['c']), para('tail')]);
    select(editor, 'a', 'c');
    move(editor, 'ArrowUp');
    expect(shape(editor)).toEqual(['[a|c]', 'lead', 'tail']);
  });

  it('carries the whole group when the selection reaches into it from outside', () => {
    const editor = open([para('top'), para('lead'), columnsBlock(['a'], ['c'])]);
    select(editor, 'lead', 'a');
    move(editor, 'ArrowUp');
    expect(shape(editor)).toEqual(['lead', '[a|c]', 'top']);
  });

  it('moves a table in a column as one block within the column', () => {
    const editor = open([
      columnsBlock({ blocks: [para('a'), tableBlock({ rows: [{ cells: ['x', 'y'] }] })] }, ['c']),
    ]);
    select(editor, 'x', 'y');
    move(editor, 'ArrowUp');
    expect(shape(editor)).toEqual(['[docTable,a|c]']);
  });
});

/**
 * The id of the block whose own words are these.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The id.
 * @throws {Error} When no block reads them.
 */
function idOf(editor: Editor, words: string): string {
  let id: string | undefined;
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) id = String(node.attrs['id']);
    return id === undefined;
  });
  if (id === undefined) throw new Error(`no block reads "${words}"`);
  return id;
}

describe('a side drop of a nested child (inner#1314 A1)', () => {
  it('takes the child out without leaving a blank child line under its list item', () => {
    const editor = open([{ type: 'bulletListItem', content: 'parent', children: [para('kid')] }, para('other')]);
    dropRowBeside(editor as never, idOf(editor, 'kid'), idOf(editor, 'other'), 'right');
    const top = editor.document as unknown as { children: unknown[] }[];
    expect(top[0]!.children).toHaveLength(0);
    expect(shape(editor)).toEqual(['bulletListItem', '[other|kid]']);
  });
});

describe('a side drop leaves the scroll where the user dropped (inner#1314 A1)', () => {
  it('asks no transaction to scroll the selection into view', () => {
    const editor = open([para('a'), para('b'), para('c')]);
    const view = editor.prosemirrorView;
    const scrolled: boolean[] = [];
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (tr): void => {
      scrolled.push(tr.scrolledIntoView);
      dispatch(tr);
    };
    dropRowBeside(editor as never, idOf(editor, 'a'), idOf(editor, 'c'), 'right');
    expect(shape(editor)).toEqual(['b', '[c|a]']);
    expect(scrolled).toEqual([false, false]);
  });
});

describe('a side drop of a row whose id stands twice (inner#1314 A1)', () => {
  it('moves the row it was given and leaves the other alone', () => {
    const editor = open([para('X'), para('T'), para('Y')]);
    const view = editor.prosemirrorView;
    const id = idOf(editor, 'X');
    let y = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'blockContainer' && node.firstChild?.textContent === 'Y') y = pos;
      return y < 0;
    });
    view.dispatch(view.state.tr.setNodeAttribute(y, 'id', id));
    dropRowBeside(editor as never, id, idOf(editor, 'T'), 'right');
    expect(shape(editor)).toEqual(['[T|X]', 'Y']);
  });
});

describe('a side drop out of a group a merge left with one column (inner#1314 design §5.1)', () => {
  it.each(['left', 'right'] as const)('moves the row on its %s, leaving no copy behind', (side) => {
    const editor = open([para('T'), columnsBlock(['gone'], ['X']), para('tail')]);
    const view = editor.prosemirrorView;
    let column = -1;
    view.state.doc.descendants((node, pos) => {
      if (column < 0 && node.type.name === 'docColumn') column = pos;
      return column < 0;
    });
    // A collaborator's change takes the first column: the group stays with one.
    const merged = view.state.tr.delete(column, column + view.state.doc.nodeAt(column)!.nodeSize);
    view.dispatch(merged.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false }));
    expect(shape(editor)).toEqual(['T', '[X]', 'tail']);
    dropRowBeside(editor as never, idOf(editor, 'X'), idOf(editor, 'T'), side);
    expect(shape(editor)).toEqual([side === 'left' ? '[X|T]' : '[T|X]', 'tail']);
  });
});

describe('a column group moved past a list item with children (inner#1314 design §5.1)', () => {
  it('goes below the whole list item on the way down', () => {
    const editor = open([columnsBlock(['a'], ['c']), { type: 'bulletListItem', content: 'L', children: [para('child')] }, para('tail')]);
    select(editor, 'a', 'c');
    move(editor, 'ArrowDown');
    const top = editor.document as unknown as { type: string; children: unknown[] }[];
    expect(top.map((block) => block.type)).toEqual(['bulletListItem', 'docColumnList', 'paragraph']);
    expect(top[0]!.children).toHaveLength(1);
  });

  it('goes above the whole list item on the way up', () => {
    const editor = open([para('lead'), { type: 'bulletListItem', content: 'L', children: [para('child')] }, columnsBlock(['a'], ['c'])]);
    select(editor, 'a', 'c');
    move(editor, 'ArrowUp');
    const top = editor.document as unknown as { type: string; children: unknown[] }[];
    expect(top.map((block) => block.type)).toEqual(['paragraph', 'docColumnList', 'bulletListItem']);
    expect(top[2]!.children).toHaveLength(1);
  });
});
