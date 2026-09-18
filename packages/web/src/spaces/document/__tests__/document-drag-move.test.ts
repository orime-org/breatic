// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A11: what the drop writes, and where.
 *
 * The arithmetic the landing rests on, over a real document: which node a row
 * id resolves to, and where a drop at a given position puts it. That the moved
 * row carries a co-editor's concurrent edit is the browser half — it needs two
 * pages on one Space, and it is the smoke case in
 * `document-block-handle.spec.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { landingFor, rowById } from '@web/spaces/document/document-drag-move';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding the given blocks.
 * @param blocks - What the document starts with.
 * @returns The editor.
 */
function open(blocks: unknown[]): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/** A block as this file reads it. */
interface Seen {
  id: string;
  type: string;
}

describe('which row an id resolves to', () => {
  it('answers with the container, nested blocks and all', () => {
    const editor = open([
      { type: 'paragraph', content: 'alpha', children: [{ type: 'paragraph', content: 'child' }] },
      { type: 'paragraph', content: 'beta' },
    ]);
    const id = (editor.document[0] as unknown as Seen).id;

    const row = editor.transact((tr) => rowById(tr.doc, id));

    expect(row).toBeDefined();
    // The container holds the row's own words and the nested one, so its text
    // is both.
    expect(row?.node.textContent).toBe('alphachild');
    expect(row?.to).toBeGreaterThan(row?.from ?? 0);
  });

  it('answers with nothing once the row is gone', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha' }]);

    const row = editor.transact((tr) => rowById(tr.doc, 'not-a-row-in-here'));

    expect(row).toBeUndefined();
  });
});

describe('where a drop lands', () => {
  it('turns a position inside a row into the gap beside it', () => {
    const editor = open([
      { type: 'paragraph', content: 'alpha' },
      { type: 'paragraph', content: 'beta' },
    ]);
    const first = (editor.document[0] as unknown as Seen).id;

    const { inside, landing } = editor.transact((tr) => {
      const row = rowById(tr.doc, first);
      if (row === undefined) throw new Error('no row');
      // A position in the middle of the second row's words.
      const second = rowById(tr.doc, (editor.document[1] as unknown as Seen).id);
      if (second === undefined) throw new Error('no second row');
      const within = second.from + 3;
      return { inside: within, landing: landingFor(tr.doc, within, row.node) };
    });

    // The landing is a place a block may sit, which a position inside a
    // paragraph's text is not.
    expect(landing).not.toBe(inside);
    expect(
      editor.transact((tr) => tr.doc.resolve(landing).parent.inlineContent),
    ).toBe(false);
  });

  it('keeps a position that already sits between rows', () => {
    const editor = open([
      { type: 'paragraph', content: 'alpha' },
      { type: 'paragraph', content: 'beta' },
    ]);
    const first = (editor.document[0] as unknown as Seen).id;

    const { between, landing } = editor.transact((tr) => {
      const row = rowById(tr.doc, first);
      if (row === undefined) throw new Error('no row');
      return { between: row.to, landing: landingFor(tr.doc, row.to, row.node) };
    });

    expect(landing).toBe(between);
  });
});
