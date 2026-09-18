// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A7: the row the handle menu's insert-below command makes.
 *
 * It has to land where the reader is pointing — under the pressed row and
 * before anything indented under it — and carry that row's own quoting.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { insertRowForMenu } from '@web/spaces/document/document-insert-row';

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

describe('the row insert-below makes', () => {
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

  it('goes below a pressed row that has nothing on it', () => {
    // A7's amended half (user 2026-09-18): the command is named for where it
    // puts the row, so an empty row gets one under it rather than becoming
    // the thing the reader chose — that is what the block type command is.
    const editor = open([{ type: 'paragraph' }]);

    const made = insertRowForMenu(editor, editor.document[0] as never);

    expect(editor.document).toHaveLength(2);
    expect((editor.document[1] as unknown as Seen).id).toBe(made);
  });

  it('puts the caret in the row it made', () => {
    const editor = open([{ type: 'paragraph', content: 'first' }]);

    const made = insertRowForMenu(editor, editor.document[0] as never);

    const where = editor.getTextCursorPosition().block as unknown as Seen;
    expect(where.id).toBe(made);
  });
});
