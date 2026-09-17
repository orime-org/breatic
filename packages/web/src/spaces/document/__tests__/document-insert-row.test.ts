// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A12 and A14: the block the insert menu opens in.
 *
 * The plus makes that block before the menu opens, because the query the
 * reader types is document text and needs somewhere to live. Two things
 * follow: it has to land where the reader is pointing, and it has to be gone
 * again if they dismiss the menu without choosing anything.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  insertRowForMenu,
  withdrawRow,
} from '@web/spaces/document/document-insert-row';

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
  props?: Record<string, unknown>;
  content?: { text?: string }[];
  children?: Seen[];
}

/**
 * The document as text, children nested, so a wrong landing spot is readable.
 * @param blocks - Blocks to describe.
 * @returns One entry per block.
 */
function shape(blocks: readonly unknown[]): unknown[] {
  return (blocks as Seen[]).map((block) => {
    const text = (block.content ?? []).map((c) => c.text ?? '').join('');
    const kids = block.children ?? [];
    return kids.length > 0 ? [text, shape(kids)] : text;
  });
}

describe('the row the insert menu opens in', () => {
  it('goes right under the pressed row and before its children', () => {
    const editor = open([
      {
        type: 'bulletListItem',
        content: 'parent',
        children: [
          { type: 'bulletListItem', content: 'first child' },
          { type: 'bulletListItem', content: 'second child' },
        ],
      },
      { type: 'paragraph', content: 'after' },
    ]);

    insertRowForMenu(editor, editor.document[0] as never);

    // `insertBlocks(…, 'after')` would put it below the whole subtree —
    // `insertBlocks.ts:41-42` advances by the container's `nodeSize`, which
    // holds the children — landing it three rows from where the reader
    // pointed.
    expect(shape(editor.document)).toEqual([
      ['parent', ['', 'first child', 'second child']],
      'after',
    ]);
  });

  it('goes after a pressed row that has nothing under it', () => {
    const editor = open([
      { type: 'paragraph', content: 'first' },
      { type: 'paragraph', content: 'second' },
    ]);

    insertRowForMenu(editor, editor.document[0] as never);

    expect(shape(editor.document)).toEqual(['first', '', 'second']);
  });

  it('carries the quote of the row it was made under', () => {
    const editor = open([
      { type: 'paragraph', content: 'quoted', props: { quoted: true } },
    ]);

    const made = insertRowForMenu(editor, editor.document[0] as never);

    expect(made).toBeDefined();
    expect((editor.document[1] as Seen).props?.quoted).toBe(true);
  });

  it('makes no row at all when the menu can open on the pressed row', () => {
    const editor = open([{ type: 'paragraph' }]);

    const made = insertRowForMenu(editor, editor.document[0] as never);

    expect(made).toBeUndefined();
    expect(editor.document).toHaveLength(1);
  });

  it('puts the caret in the row it made', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);

    const made = insertRowForMenu(editor, editor.document[0] as never);

    const where = editor.getTextCursorPosition().block as unknown as Seen;
    expect(where.id).toBe(made);
  });
});

describe('withdrawing the row when the reader chose nothing', () => {
  it('takes the row back out', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;

    withdrawRow(editor, made);

    expect(shape(editor.document)).toEqual(['first']);
  });

  it('leaves it alone once it holds text', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    // A co-editor can write into that block while the menu is open; taking it
    // away would take their text with it.
    editor.updateBlock(made, { content: 'theirs' } as never);

    withdrawRow(editor, made);

    expect(shape(editor.document)).toEqual(['first', 'theirs']);
  });

  it('says nothing when the row is already gone', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    editor.removeBlocks([made]);

    expect(() => {
      withdrawRow(editor, made);
    }).not.toThrow();
    expect(shape(editor.document)).toEqual(['first']);
  });
});
