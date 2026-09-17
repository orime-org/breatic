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
  withdrawInsert,
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

describe('withdrawing the insert when the reader chose nothing', () => {
  it('takes back the row the plus made', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    withdrawInsert(editor, { blockId: made, made: true }, '');

    expect(shape(editor.document)).toEqual(['first']);
  });

  it('takes back what was typed into the menu with it', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    editor.updateBlock(made, { content: 'head' } as never);

    withdrawInsert(editor, { blockId: made, made: true }, 'head');

    expect(shape(editor.document)).toEqual(['first']);
  });

  it('leaves every other row alone, wherever the caret went', () => {
    // The dismissal that costs the most: the reader presses the plus on the
    // first row and then clicks back into the text several rows down, which is
    // itself one of the plugin's reasons to close. Withdrawing by deleting a
    // range from the query to the caret took everything in between with it —
    // measured in a browser, a four-row document came back as one row.
    const editor = open([
      { type: 'paragraph', content: 'one' },
      { type: 'paragraph', content: 'two' },
      { type: 'paragraph', content: 'three' },
      { type: 'paragraph', content: 'four' },
    ]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    editor.updateBlock(made, { content: 'qu' } as never);
    editor.setTextCursorPosition(
      (editor.document[4] as Seen).id,
      'end',
    );

    withdrawInsert(editor, { blockId: made, made: true }, 'qu');

    expect(shape(editor.document)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('leaves the row alone when it holds anything else', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    // A co-editor can write into that block while the menu is open; taking it
    // away would take their text with it.
    editor.updateBlock(made, { content: 'theirs' } as never);

    withdrawInsert(editor, { blockId: made, made: true }, '');

    expect(shape(editor.document)).toEqual(['first', 'theirs']);
  });

  it('empties the reader’s own row rather than removing it', () => {
    // Pressing the plus on a row that shows nothing opens the menu in that
    // row (`insertPlanFor`), so the row is the reader's, not ours.
    const editor = open([
      { type: 'paragraph', content: 'first' },
      { type: 'paragraph' },
    ]);
    const row = (editor.document[1] as Seen).id;
    expect(insertRowForMenu(editor, editor.document[1] as never)).toBeUndefined();
    editor.updateBlock(row, { content: 'qu' } as never);

    withdrawInsert(editor, { blockId: row, made: false }, 'qu');

    expect(shape(editor.document)).toEqual(['first', '']);
  });

  it('says nothing when the row is already gone', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);
    const made = insertRowForMenu(editor, editor.document[0] as never)!;
    editor.removeBlocks([made]);

    expect(() => {
      withdrawInsert(editor, { blockId: made, made: true }, '');
    }).not.toThrow();
    expect(shape(editor.document)).toEqual(['first']);
  });
});
