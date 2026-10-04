// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A5: what the table entry's menu runs on the table under the
 * pointer, leaving the reader's own caret where it was.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { canCommentOver } from '@web/spaces/document/document-comment-target';
import {
  deleteRow,
  duplicateRow,
  indentReach,
  indentRow,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * A 2 × 2 table block.
 * @param cells - The four cells' text.
 * @returns The block.
 */
function table(cells: readonly [string, string, string, string]): unknown {
  return {
    type: 'table',
    content: {
      type: 'tableContent',
      rows: [{ cells: [cells[0], cells[1]] }, { cells: [cells[2], cells[3]] }],
    },
  };
}

/**
 * Opens a mounted editor holding the given blocks.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function open(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/** A block as `editor.document` hands it back. */
interface Seen {
  id: string;
  type: string;
  children: Seen[];
}

/**
 * The top-level blocks, each with its children's types.
 * @param editor - The editor.
 * @returns `type` or `type>child,child`.
 */
function shape(editor: Editor): string[] {
  return (editor.document as unknown as Seen[]).map((b) =>
    b.children.length === 0 ? b.type : `${b.type}>${b.children.map((c) => c.type).join(',')}`,
  );
}

/**
 * Puts the caret into a word.
 * @param editor - The editor.
 * @param word - The word.
 * @param offset - How far into it.
 * @returns The caret's position.
 */
function caretIn(editor: Editor, word: string, offset: number): number {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(word) === true) {
      at = pos + node.text.indexOf(word) + offset;
    }
    return at < 0;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  return at;
}

/**
 * The table block.
 * @param editor - The editor.
 * @returns It.
 */
function tableBlock(editor: Editor): PressedBlock {
  const find = (blocks: Seen[]): Seen | undefined =>
    blocks.find((b) => b.type === 'table') ?? blocks.flatMap((b) => b.children).find((b) => b.type === 'table');
  const found = find(editor.document as unknown as Seen[]);
  if (found === undefined) throw new Error('no table');
  return found as unknown as PressedBlock;
}

describe('indenting a table off its entry', () => {
  it('nests it under the block above and leaves the reader where they were', () => {
    const editor = open([{ type: 'paragraph', content: 'above' }, table(['a', 'b', 'c', 'd'])]);
    caretIn(editor, 'above', 2);
    const id = tableBlock(editor).id;

    indentRow(editor, id, true);

    expect(shape(editor)).toEqual(['paragraph>table']);
    const { selection } = editor.prosemirrorState;
    expect(selection.empty).toBe(true);
    expect(selection.$head.parent.textContent).toBe('above');
    expect(selection.$head.parentOffset).toBe(2);
  });

  it('lifts a nested table back out', () => {
    const editor = open([
      { type: 'paragraph', content: 'above', children: [table(['a', 'b', 'c', 'd'])] },
    ]);
    caretIn(editor, 'above', 1);

    indentRow(editor, tableBlock(editor).id, false);

    expect(shape(editor)).toEqual(['paragraph', 'table']);
    expect(editor.prosemirrorState.selection.$head.parentOffset).toBe(1);
  });

  it('says which way the table can go', () => {
    const first = open([table(['a', 'b', 'c', 'd']), { type: 'paragraph', content: 'below' }]);
    expect(indentReach(first.prosemirrorState.doc, tableBlock(first).id)).toEqual({
      in: false,
      out: false,
    });

    const after = open([{ type: 'paragraph', content: 'above' }, table(['a', 'b', 'c', 'd'])]);
    expect(indentReach(after.prosemirrorState.doc, tableBlock(after).id)).toEqual({
      in: true,
      out: false,
    });

    const nested = open([
      { type: 'paragraph', content: 'above', children: [table(['a', 'b', 'c', 'd'])] },
    ]);
    expect(indentReach(nested.prosemirrorState.doc, tableBlock(nested).id)).toEqual({
      in: false,
      out: true,
    });
  });
});

describe('the other rows of the table entry', () => {
  it('duplicates the table with its cells', () => {
    const editor = open([table(['a', 'b', 'c', 'd'])]);

    duplicateRow(editor, tableBlock(editor));

    expect(shape(editor)).toEqual(['table', 'table']);
    const texts: string[] = [];
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'tableParagraph') texts.push(node.textContent);
    });
    expect(texts).toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']);
  });

  it('deletes the table', () => {
    const editor = open([{ type: 'paragraph', content: 'above' }, table(['a', 'b', 'c', 'd'])]);

    deleteRow(editor, tableBlock(editor).id);

    expect(shape(editor)).toEqual(['paragraph']);
  });

  it('offers a comment over a table that holds words, and not over an empty one', () => {
    const full = open([table(['a', '', '', ''])]);
    const fullDoc = full.prosemirrorState.doc;
    expect(canCommentOver(fullDoc, selectionOverBlockContent(fullDoc, tableBlock(full).id))).toBe(
      true,
    );

    const empty = open([table(['', '', '', ''])]);
    const emptyDoc = empty.prosemirrorState.doc;
    expect(
      canCommentOver(emptyDoc, selectionOverBlockContent(emptyDoc, tableBlock(empty).id)),
    ).toBe(false);
  });
});
