// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 design §5.5: the AI dialog's range over columns. A range that
 * leaves one column takes the whole column group, as one leaving a cell
 * takes the whole table; a range inside one column takes that column's
 * blocks. The group taken is the one standing right in the body that holds
 * both ends, so a table in a column and a group in a cell go by the same rule.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { aiCapture } from '@web/spaces/document/document-ai-launch';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';
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
function open(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where some words start.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The position.
 */
function at(editor: Editor, words: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(words) === true) found = pos + node.text.indexOf(words);
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${words}"`);
  return found;
}

/**
 * Selects between two positions.
 * @param editor - The editor.
 * @param from - The start.
 * @param to - The end.
 */
function select(editor: Editor, from: number, to: number): void {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/**
 * The id of the block, column group or table a node of this type and these
 * words belongs to.
 * @param editor - The editor.
 * @param type - The node type.
 * @param words - Words inside it; the first of the type when left out.
 * @returns The id.
 */
function idOf(editor: Editor, type: string, words?: string): string {
  let found: string | undefined;
  editor.prosemirrorState.doc.descendants((node) => {
    if (found === undefined && node.type.name === type && (words === undefined || node.textContent.includes(words))) {
      found = String(node.attrs['id']);
    }
    return found === undefined;
  });
  if (found === undefined) throw new Error(`no ${type}`);
  return found;
}

/**
 * The first and last block the dialog takes for the selection.
 * @param editor - The editor.
 * @returns Their ids.
 */
function taken(editor: Editor): [string | null, string | null] {
  const captured = aiCapture(editor.prosemirrorState)!;
  return [captured.firstId, captured.lastId];
}

describe('the AI dialog\'s range over columns', () => {
  it('takes the whole group for a selection across two columns', () => {
    const editor = open([para('lead'), columnsBlock(['alpha'], ['gamma'])]);
    select(editor, at(editor, 'alpha') + 1, at(editor, 'gamma') + 2);
    const group = idOf(editor, 'docColumnList');
    expect(taken(editor)).toEqual([group, group]);
  });

  it('takes the whole group a selection runs into from the body', () => {
    const editor = open([para('lead'), columnsBlock(['alpha'], ['gamma'])]);
    select(editor, at(editor, 'lead'), at(editor, 'alpha') + 2);
    expect(taken(editor)).toEqual([idOf(editor, 'blockContainer', 'lead'), idOf(editor, 'docColumnList')]);
  });

  it('takes the blocks of one column for a selection across them', () => {
    const editor = open([columnsBlock(['alpha', 'beta'], ['gamma'])]);
    select(editor, at(editor, 'alpha') + 1, at(editor, 'beta') + 2);
    expect(taken(editor)).toEqual([idOf(editor, 'blockContainer', 'alpha'), idOf(editor, 'blockContainer', 'beta')]);
  });

  it('takes the group, not the table, from a cell of a table in a column into the next column', () => {
    const editor = open([columnsBlock({ blocks: [tableBlock({ rows: [{ cells: ['x', 'y'] }] })] }, ['gamma'])]);
    select(editor, at(editor, 'x'), at(editor, 'gamma') + 2);
    const group = idOf(editor, 'docColumnList');
    expect(taken(editor)).toEqual([group, group]);
  });

  it('takes the group, not the table, across the columns of a group in one cell', () => {
    const editor = open([tableBlock({ rows: [{ cells: [{ blocks: [columnsBlock(['p'], ['q'])] }, 'r'] }] })]);
    select(editor, at(editor, 'p'), at(editor, 'q') + 1);
    const group = idOf(editor, 'docColumnList');
    expect(taken(editor)).toEqual([group, group]);
  });
});
