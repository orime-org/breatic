// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T6 and design 5.3: moving blocks in and around a table. A block
 * in a cell moves within its cell and stops at the cell's edges; a block
 * outside moves past the whole table as past one block; a selection that
 * reaches into a table from outside, or across cells, takes the whole table
 * along. A cell a block leaves keeps an empty paragraph, never goes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding the given blocks.
 * @param blocks - The blocks.
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

const p = (words: string): unknown => ({ type: 'paragraph', content: words });

/**
 * Where some words start.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The position.
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
 * Selects from one word's start to another's end.
 * @param editor - The editor.
 * @param from - The first words.
 * @param to - The last words.
 */
function select(editor: Editor, from: string, to: string): void {
  const view = editor.prosemirrorView;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, at(editor, from), at(editor, to) + to.length)),
  );
}

/**
 * Presses Shift+Mod with an arrow.
 * @param editor - The editor.
 * @param key - The arrow.
 */
function move(editor: Editor, key: 'ArrowUp' | 'ArrowDown'): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, shiftKey: true, ctrlKey: true, bubbles: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
}

/**
 * The body's top-level blocks, a table as its cells' words.
 * @param editor - The editor.
 * @returns One entry per block.
 */
function body(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.child(0).forEach((block) => {
    if (block.type.name !== 'docTable') {
      out.push(block.textContent);
      return;
    }
    const cells: string[] = [];
    block.forEach((row) => row.forEach((cell) => {
      const lines: string[] = [];
      cell.descendants((node) => {
        if (node.isTextblock) lines.push(node.textContent);
        return !node.isTextblock;
      });
      cells.push(lines.join('/'));
    }));
    out.push(`[${cells.join(' | ')}]`);
  });
  return out;
}

describe('moving blocks in and around a table', () => {
  it('moves a block within its cell', () => {
    const editor = open([tableBlock({ rows: [{ cells: [{ blocks: [p('one'), p('two')] }, 'b'] }] })]);
    select(editor, 'two', 'two');

    move(editor, 'ArrowUp');

    expect(body(editor)).toEqual(['[two/one | b]']);
  });

  it.each(['ArrowUp', 'ArrowDown'] as const)('stops a block at the edge of its cell (%s)', (key) => {
    const editor = open([p('above'), tableBlock({ rows: [{ cells: ['a', 'b'] }] }), p('below')]);
    select(editor, key === 'ArrowUp' ? 'a' : 'b', key === 'ArrowUp' ? 'a' : 'b');
    const before = editor.prosemirrorState.doc;

    move(editor, key);

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('moves a block below the table up past the whole table', () => {
    const editor = open([p('above'), tableBlock({ rows: [{ cells: ['a', 'b'] }] }), p('below')]);
    select(editor, 'below', 'below');

    move(editor, 'ArrowUp');

    expect(body(editor)).toEqual(['above', 'below', '[a | b]']);
  });

  it('moves a block above the table down past the whole table', () => {
    const editor = open([p('above'), tableBlock({ rows: [{ cells: ['a', 'b'] }] }), p('below')]);
    select(editor, 'above', 'above');

    move(editor, 'ArrowDown');

    expect(body(editor)).toEqual(['[a | b]', 'above', 'below']);
  });

  it('takes the whole table along when the selection reaches into it from outside', () => {
    const editor = open([p('above'), tableBlock({ rows: [{ cells: ['a', 'b'] }] }), p('below')]);
    select(editor, 'above', 'a');

    move(editor, 'ArrowDown');

    expect(body(editor)).toEqual(['below', 'above', '[a | b]']);
  });
});

describe('a cell a block leaves', () => {
  it('keeps an empty paragraph, and stays the cell it was, when its only block is dragged out', () => {
    const editor = open([
      p('lead'),
      tableBlock({ rows: [{ cells: [{ content: 'a', props: { backgroundColor: 'blue' } }, 'b'] }, { cells: ['c', 'd'] }] }),
    ]);
    const view = editor.prosemirrorView;
    let id = '';
    view.state.doc.descendants((node) => {
      if (id === '' && node.type.name === 'blockContainer' && node.textContent === 'a') id = String(node.attrs['id']);
      return id === '';
    });

    moveRowTo(view, id, 1);

    expect(body(editor)).toEqual(['a', 'lead', '[ | b | c | d]']);
    const table = view.state.doc.child(0).child(2);
    expect(TableMap.get(table).width).toBe(2);
    expect(TableMap.get(table).height).toBe(2);
    expect(table.child(0).child(0).attrs['backgroundColor']).toBe('blue');
    expect(() => view.state.doc.check()).not.toThrow();
  });
});
