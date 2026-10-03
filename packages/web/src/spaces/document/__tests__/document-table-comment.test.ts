// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A9: a comment on several selected cells is one thread whose mark
 * lands on the words of every selected cell — and only those, even where the
 * cells are not next to each other in the document.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { commentTool } from '@web/spaces/document/document-comment-entries';
import { draftRangeIn } from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import { deleteRowAt } from '@web/spaces/document/document-table-run';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens an editor with comments wired, holding a 2 × 2 table.
 * @returns The editor.
 */
function open(): Editor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] },
    },
  ] as never);
  return editor;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'tableCell' && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * Which cells carry a comment mark.
 * @param editor - The editor.
 * @returns Their texts.
 */
function commented(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'tableCell') {
      let marked = false;
      node.descendants((child) => {
        if (child.marks.some((mark) => mark.type.name === 'comment')) marked = true;
      });
      if (marked) out.push(node.textContent);
      return false;
    }
    return true;
  });
  return out;
}

describe('a comment on a column of cells', () => {
  it('aims a draft at the words of each selected cell', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellOf(editor, 'a1'), cellOf(editor, 'a2')),
      ),
    );
    expect(commentTool.canRun(editor)).toBe(true);

    commentTool.run(editor);

    const aim = draftRangeIn(editor.prosemirrorState)!;
    const texts = aim.segments.map(({ from, to }) => editor.prosemirrorState.doc.textBetween(from, to));
    expect(texts).toEqual(['a1', 'a2']);
  });

  it('marks those cells and no other once posted', async () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellOf(editor, 'a1'), cellOf(editor, 'a2')),
      ),
    );
    commentTool.run(editor);

    await postComment(editor, 'about the first column');

    expect(commented(editor)).toEqual(['a1', 'a2']);
  });

  it('stays on the cells left when one of them is deleted', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellOf(editor, 'a1'), cellOf(editor, 'a2')),
      ),
    );
    commentTool.run(editor);

    deleteRowAt(editor, cellOf(editor, 'a2'));

    const aim = draftRangeIn(editor.prosemirrorState)!;
    expect(aim.segments.map(({ from, to }) => editor.prosemirrorState.doc.textBetween(from, to))).toEqual(['a1']);
  });
});
