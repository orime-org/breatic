// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shift-Mod-ArrowUp and Shift-Mod-ArrowDown move the row the caret is in, and
 * a row carries its comment marks with it (#18).
 *
 * BlockNote's own binding rebuilds the moved rows from their JSON, which has
 * no place for a comment mark, so a moved row came out of the move with its
 * comments' highlights gone and their threads orphaned. Where each press puts
 * the row is BlockNote's rule, and the cases below hold ours to it by running
 * both on the same document.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A row to put in, and what it reads back as. */
interface Row {
  readonly id: string;
  readonly text: string;
  readonly children?: readonly Row[];
}

/**
 * Turns rows into the blocks BlockNote takes.
 * @param rows - The rows.
 * @returns The blocks.
 */
function blocksOf(rows: readonly Row[]): unknown[] {
  return rows.map((row) => ({
    id: row.id,
    type: 'paragraph',
    content: row.text,
    children: blocksOf(row.children ?? []),
  }));
}

/**
 * Opens an editor holding the rows.
 * @param rows - The rows.
 * @returns The editor, mounted.
 */
function open(rows: readonly Row[]): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocksOf(rows) as never);
  return editor;
}

/**
 * The document read back as rows.
 * @param editor - The editor.
 * @returns Its rows.
 */
function rowsOf(editor: Editor): Row[] {
  /**
   * Reads blocks as rows.
   * @param blocks - The blocks.
   * @returns The rows.
   */
  const read = (blocks: readonly unknown[]): Row[] =>
    (
      blocks as {
        id: string;
        content: { text: string }[];
        children: unknown[];
      }[]
    ).map((block) => ({
      id: block.id,
      text: block.content.map((part) => part.text).join(''),
      children: read(block.children),
    }));
  return read(editor.document as unknown[]);
}

/**
 * Where a row's words start.
 * @param editor - The editor.
 * @param id - The row.
 * @returns The position before its first letter.
 */
function wordsOf(editor: Editor, id: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at !== -1) return false;
    if (node.attrs['id'] === id) at = pos + 2;
    return true;
  });
  return at;
}

/**
 * Puts a selection over rows' words.
 * @param editor - The editor.
 * @param from - The row, and the offset into its words, the selection starts at.
 * @param to - The same, where it ends.
 */
function select(
  editor: Editor,
  from: readonly [string, number],
  to: readonly [string, number] = from,
): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(
        view.state.doc,
        wordsOf(editor, from[0]) + from[1],
        wordsOf(editor, to[0]) + to[1],
      ),
    ),
  );
}

/**
 * Presses Shift-Mod with an arrow.
 * @param editor - The editor.
 * @param key - Which arrow.
 * @returns Whether a handler claimed it.
 */
function press(editor: Editor, key: 'ArrowUp' | 'ArrowDown'): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
  });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

const A = { id: 'a', text: 'alpha' };
const B = { id: 'b', text: 'bravo' };
const C = { id: 'c', text: 'charlie' };
const D = { id: 'd', text: 'delta' };
const A1 = { id: 'a1', text: 'alpha one' };
const B1 = { id: 'b1', text: 'bravo one' };

/** Rows at three depths: a selection from `x2` to `x8` takes rows from each. */
const DEEP = [
  {
    id: 'x0',
    text: 'x zero',
    children: [
      {
        id: 'x1',
        text: 'x one',
        children: [
          { id: 'x2', text: 'x two' },
          { id: 'x3', text: 'x three' },
        ],
      },
      { id: 'x4', text: 'x four' },
    ],
  },
  { id: 'x7', text: 'x seven' },
  { id: 'x8', text: 'x eight' },
  { id: 'x9', text: 'x nine' },
];

describe('moving a row from the keyboard', () => {
  it.each([
    // [case, rows, where the selection is, which arrow]
    ['a row up past its neighbour', [A, B, C], ['b', 2], undefined, 'ArrowUp'],
    ['a row down past its neighbour', [A, B, C], ['b', 2], undefined, 'ArrowDown'],
    [
      'a row up into the rows under the one above',
      [{ ...A, children: [A1] }, B],
      ['b', 1],
      undefined,
      'ArrowUp',
    ],
    [
      'the first row under another up out of it',
      [{ ...A, children: [A1] }],
      ['a1', 1],
      undefined,
      'ArrowUp',
    ],
    [
      'a row down into the rows under the one below',
      [A, { ...B, children: [B1] }],
      ['a', 1],
      undefined,
      'ArrowDown',
    ],
    [
      'the last row under another down out of it',
      [{ ...A, children: [A1] }, B],
      ['a1', 1],
      undefined,
      'ArrowDown',
    ],
    ['the first row up', [A, B], ['a', 1], undefined, 'ArrowUp'],
    ['the last row down', [A, B], ['b', 1], undefined, 'ArrowDown'],
    [
      'two selected rows down together',
      [A, B, C, D],
      ['b', 1],
      ['c', 3],
      'ArrowDown',
    ],
    [
      'two selected rows up together',
      [A, B, C, D],
      ['b', 1],
      ['c', 3],
      'ArrowUp',
    ],
    [
      'rows selected across three depths down',
      DEEP,
      ['x2', 1],
      ['x8', 3],
      'ArrowDown',
    ],
    [
      'rows selected across three depths up',
      DEEP,
      ['x2', 1],
      ['x8', 3],
      'ArrowUp',
    ],
  ] as const)(
    'puts %s where BlockNote puts it',
    (_case, rows, from, to, key) => {
      const ours = open(rows);
      const theirs = open(rows);
      select(ours, from, to ?? from);
      select(theirs, from, to ?? from);

      expect(press(ours, key)).toBe(true);
      if (key === 'ArrowUp') theirs.moveBlocksUp();
      else theirs.moveBlocksDown();

      expect(rowsOf(ours)).toEqual(rowsOf(theirs));
      expect(ours.prosemirrorState.selection.anchor).toBe(
        theirs.prosemirrorState.selection.anchor,
      );
      expect(ours.prosemirrorState.selection.head).toBe(
        theirs.prosemirrorState.selection.head,
      );
    },
  );

  it('keeps the selection on the same letters of the moved rows', () => {
    const editor = open([A, B, C]);
    select(editor, ['b', 1], ['b', 4]);

    press(editor, 'ArrowUp');

    const { from, to } = editor.prosemirrorState.selection;
    expect(from).toBe(wordsOf(editor, 'b') + 1);
    expect(to).toBe(wordsOf(editor, 'b') + 4);
  });

  it.each(['ArrowUp', 'ArrowDown'] as const)(
    'keeps the comment on the words of a row moved with %s',
    (key) => {
      const editor = open([A, B, C]);
      const at = wordsOf(editor, 'b');
      const view = editor.prosemirrorView!;
      const comment = view.state.schema.marks['comment']!.create({
        threadId: 't1',
        orphan: false,
      });
      view.dispatch(view.state.tr.addMark(at, at + 5, comment));
      select(editor, ['b', 2]);

      press(editor, key);

      const moved = wordsOf(editor, 'b');
      const marked = editor.prosemirrorState.doc.rangeHasMark(
        moved,
        moved + 5,
        view.state.schema.marks['comment']!,
      );
      expect(rowsOf(editor).map((row) => row.id)).toEqual(
        key === 'ArrowUp' ? ['b', 'a', 'c'] : ['a', 'c', 'b'],
      );
      expect(marked).toBe(true);
    },
  );
});
