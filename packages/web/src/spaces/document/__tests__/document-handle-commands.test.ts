// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A8 and A9: the two commands on the block handle menu that
 * act on the whole block rather than on its type.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  duplicateRow,
  deleteRow,
} from '@web/spaces/document/document-handle-commands';

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
  content?: { text?: string }[];
  children?: Seen[];
}

/**
 * The document as text, children nested.
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

const NESTED = [
  {
    type: 'bulletListItem',
    content: 'parent',
    children: [{ type: 'bulletListItem', content: 'child' }],
  },
  { type: 'paragraph', content: 'after' },
];

describe('duplicating the block under the pointer', () => {
  it('puts a copy below it, nested blocks and all', () => {
    const editor = open(NESTED);
    const pressed = editor.document[0] as unknown as Seen;

    duplicateRow(editor, pressed as never);

    expect(shape(editor.document)).toEqual([
      ['parent', ['child']],
      ['parent', ['child']],
      'after',
    ]);
    // Below, not above: the two look alike, so which one is the original is
    // the only thing that tells the copy's side apart.
    expect((editor.document[0] as unknown as Seen).id).toBe(pressed.id);
  });

  it('makes a second block rather than a second reference to the first', () => {
    const editor = open(NESTED);

    duplicateRow(editor, editor.document[0] as never);

    const [first, second] = editor.document as unknown as Seen[];
    expect(second!.id).not.toBe(first!.id);
    // Editing the copy has to leave the original alone.
    editor.updateBlock(second!.id, { content: 'changed' } as never);
    expect(shape(editor.document)).toEqual([
      ['parent', ['child']],
      ['changed', ['child']],
      'after',
    ]);
  });
});

describe('deleting the block under the pointer', () => {
  it('takes the block and everything indented under it', () => {
    const editor = open(NESTED);

    deleteRow(editor, (editor.document[0] as unknown as Seen).id);

    expect(shape(editor.document)).toEqual(['after']);
  });

  it('leaves one empty paragraph when it was the only block', () => {
    const editor = open([{ type: 'heading', content: 'the only one' }]);

    deleteRow(editor, (editor.document[0] as unknown as Seen).id);

    // `BlockGroup.ts:11` is `blockGroupChild+`, so a document with no blocks
    // is not a state this editor can rest in — the same reason clearing the
    // whole document leaves one (`document-select-all-guard.ts:25-27`).
    expect(shape(editor.document)).toEqual(['']);
    expect((editor.document[0] as unknown as Seen).type).toBe('paragraph');
  });
});
