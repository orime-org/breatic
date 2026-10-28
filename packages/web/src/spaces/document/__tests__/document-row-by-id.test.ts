// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The words of a row, and a table among the rows (inner#1619): a table stands
 * with no container around it and has no words of its own to sit in.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { contentRangeOf, rowById } from '@web/spaces/document/document-row-by-id';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding a line and a table.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'lead' }, tableBlock({ rows: [{ cells: ['a1', 'b1'] }] })] as never);
  return editor;
}

describe('the words of a row', () => {
  it('are the line\'s own words', () => {
    const editor = open();
    const { doc } = editor.prosemirrorView.state;
    const row = rowById(doc, (editor.document[0] as { id: string }).id)!;

    const words = contentRangeOf(row)!;

    expect(doc.textBetween(words.from, words.to)).toBe('lead');
  });

  it('are none for a table, whose words are its cells\' rows', () => {
    const editor = open();
    const row = rowById(editor.prosemirrorView.state.doc, (editor.document[1] as { id: string }).id)!;

    expect(contentRangeOf(row)).toBeUndefined();
  });
});
