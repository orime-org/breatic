// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1314 design §5.1 "归一化兜底": a column group that a local change
 * leaves in a column (at any depth) or under another block stands unfolded,
 * its columns' blocks one under another in reading order, no words lost.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
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
 * The id of the block whose words are these.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The id.
 */
function idOf(editor: Editor, words: string): string {
  let found: string | undefined;
  editor.prosemirrorState.doc.descendants((node) => {
    if (found === undefined && node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      found = String(node.attrs['id']);
    }
    return found === undefined;
  });
  if (found === undefined) throw new Error(`no "${words}"`);
  return found;
}

/**
 * How many column groups the document holds, and every text block's words in
 * document order.
 * @param editor - The editor.
 * @returns The count and the words.
 */
function read(editor: Editor): { groups: number; words: string[] } {
  let groups = 0;
  const words: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'docColumnList') groups += 1;
    if (node.isTextblock) words.push(node.textContent);
    return !node.isTextblock;
  });
  return { groups, words };
}

describe('a column group where none may stand', () => {
  it('unfolds under a list item, in reading order', () => {
    const editor = open([{ type: 'bulletListItem', content: 'item', children: [para('child')] }]);
    editor.insertBlocks([columnsBlock(['p', 'q'], ['r'])] as never, idOf(editor, 'child'), 'after');
    expect(read(editor)).toEqual({ groups: 0, words: ['item', 'child', 'p', 'q', 'r'] });
  });

  it('unfolds in a cell of a table in a column', () => {
    const editor = open([
      columnsBlock({ blocks: [tableBlock({ rows: [{ cells: ['x', 'y'] }] })] }, ['c']),
    ]);
    editor.insertBlocks([columnsBlock(['p'], ['q'])] as never, idOf(editor, 'x'), 'after');
    expect(read(editor)).toEqual({ groups: 1, words: ['x', 'p', 'q', 'y', 'c'] });
  });

  it('stays in a cell of a table in the body', () => {
    const editor = open([tableBlock({ rows: [{ cells: ['x', 'y'] }] })]);
    editor.insertBlocks([columnsBlock(['p'], ['q'])] as never, idOf(editor, 'x'), 'after');
    expect(read(editor).groups).toBe(1);
  });
});
