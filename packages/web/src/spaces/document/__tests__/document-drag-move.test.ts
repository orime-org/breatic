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
import {
  landingFor,
  moveRowTo,
} from '@web/spaces/document/document-drag-move';
import { rowById } from '@web/spaces/document/document-row-by-id';

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

/**
 * Every row in the document, top level and nested, as `type:text`.
 * @param editor - The editor to read.
 * @returns One entry per block container, in document order.
 */
function rowsOf(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  return editor.transact((tr) => {
    const seen: string[] = [];
    tr.doc.descendants((node) => {
      if (node.type.name !== 'blockContainer') return true;
      const content = node.firstChild;
      seen.push(`${content?.type.name ?? '?'}:${content?.textContent ?? ''}`);
      return true;
    });
    return seen;
  });
}

/**
 * A document position inside the given row's own words.
 * @param editor - The editor to read.
 * @param blockId - Which row.
 * @returns A position the pointer could be over.
 */
function insideRow(
  editor: ReturnType<typeof buildDocumentEditor>,
  blockId: string,
): number {
  return editor.transact((tr) => {
    const row = rowById(tr.doc, blockId);
    if (row === undefined) throw new Error('no row');
    return row.from + 2;
  });
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

describe('what the move writes', () => {
  it('lands the row at the gap the pointer was nearest, once', () => {
    const editor = open([
      { type: 'paragraph', content: 'alpha' },
      { type: 'paragraph', content: 'beta' },
      { type: 'paragraph', content: 'gamma' },
    ]);
    const first = (editor.document[0] as unknown as Seen).id;
    const last = (editor.document[2] as unknown as Seen).id;

    moveRowTo(editor.prosemirrorView, first, insideRow(editor, last));

    // A position near the start of the last row is the gap ABOVE it, which is
    // what `dropPoint` answers and what the drop cursor draws.
    expect(rowsOf(editor)).toEqual([
      'paragraph:beta',
      'paragraph:alpha',
      'paragraph:gamma',
    ]);
  });

  it('leaves a one-row document alone when the row is dropped on itself', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha' }]);
    const only = (editor.document[0] as unknown as Seen).id;

    moveRowTo(editor.prosemirrorView, only, insideRow(editor, only));

    expect(rowsOf(editor)).toEqual(['paragraph:alpha']);
  });

  it('takes the empty group with it when the row was its only child', () => {
    const editor = open([
      {
        type: 'paragraph',
        content: 'parent',
        children: [{ type: 'paragraph', content: 'child' }],
      },
      { type: 'paragraph', content: 'beta' },
    ]);
    const nested = (
      (editor.document[0] as unknown as { children: Seen[] }).children[0] as Seen
    ).id;
    const last = (editor.document[1] as unknown as Seen).id;

    moveRowTo(editor.prosemirrorView, nested, insideRow(editor, last));

    // Three rows, none of them the empty one the schema refills an emptied
    // group with.
    expect(rowsOf(editor)).toEqual([
      'paragraph:parent',
      'paragraph:child',
      'paragraph:beta',
    ]);
  });

  it('answers with nothing when the row left the document mid-flight', () => {
    const editor = open([{ type: 'paragraph', content: 'alpha' }]);
    const only = (editor.document[0] as unknown as Seen).id;
    const at = insideRow(editor, only);

    expect(moveRowTo(editor.prosemirrorView, 'a-row-that-is-gone', at)).toBe(
      false,
    );
  });
});
