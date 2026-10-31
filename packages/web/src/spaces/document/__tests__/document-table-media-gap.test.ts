// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T7: files picked from the plus or dropped in a cell land in that
 * cell, as they land in the body (a cell is a small body).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blockGapAt } from '@web/spaces/document/document-upload-slots';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding a paragraph, a one-row table of "a" and an empty
 * cell, and a paragraph.
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
    tableBlock({ rows: [{ cells: ['a', ''] }] }),
    { type: 'paragraph', content: 'below' },
  ] as never);
  return editor;
}

/**
 * Where each block in a cell starts, by its words.
 * @param editor - The editor.
 * @returns Block start positions inside cells, keyed by the block's words.
 */
function cellBlocks(editor: Editor): Map<string, number> {
  const found = new Map<string, number>();
  editor.prosemirrorState.doc.descendants((node, pos, parent) => {
    if (node.type.name === 'blockContainer' && parent?.type.name === 'docTableCell') found.set(node.textContent, pos);
    return true;
  });
  return found;
}

describe('the gap files land in, in a table cell', () => {
  it('stays in the cell for a gap above a block there', () => {
    const editor = open();
    const doc = editor.prosemirrorState.doc;
    const empty = cellBlocks(editor).get('')!;

    const gap = blockGapAt(doc, empty);

    expect(gap).toBe(empty);
    expect(doc.resolve(gap).parent.type.name).toBe('docTableCell');
  });

  it('is the gap under the block for a position inside a block in the cell', () => {
    const editor = open();
    const doc = editor.prosemirrorState.doc;
    const a = cellBlocks(editor).get('a')!;

    const gap = blockGapAt(doc, a + 3);

    expect(gap).toBe(a + doc.nodeAt(a)!.nodeSize);
    expect(doc.resolve(gap).parent.type.name).toBe('docTableCell');
  });
});
