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
import {
  insertBelow,
  insertRowForMenu,
  insertMediaBelow,
  insertMediaOnRow,
} from '@web/spaces/document/document-insert-row';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

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
    // Insert-below is named for where it puts the row, so an empty row the
    // grip serves — any but an empty paragraph, which shows the plus instead
    // (#1097) — gets one under it rather than becoming the thing picked.
    const editor = open([{ type: 'heading', props: { level: 2 } }]);

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

describe('a table inserted below (inner#1126 A1)', () => {
  const PICK = { table: { rows: 3, cols: 4 } } as const;

  /** A block as `editor.document` hands it back, table content included. */
  interface Read {
    id: string;
    type: string;
    props: Record<string, unknown>;
    content: unknown;
  }

  it('goes under the row with an empty line after it, caret in the first cell', () => {
    const editor = open([
      { type: 'paragraph', content: 'pressed' },
      { type: 'paragraph', content: 'after' },
    ]);

    insertBelow(editor, editor.document[0] as never, PICK);

    const blocks = editor.document as unknown as Read[];
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph', 'paragraph']);
    const rows = (blocks[1]!.content as { rows: { cells: unknown[] }[] }).rows;
    expect(rows.map((r) => r.cells.length)).toEqual([4, 4, 4]);
    expect(blocks[2]!.content).toEqual([]);
    const { $head } = editor.prosemirrorState.selection;
    expect($head.parent.type.name).toBe('tableParagraph');
    expect([$head.index($head.depth - 3), $head.index($head.depth - 2)]).toEqual([0, 0]);
  });

  it('carries the quote of the row to the table and the line after it', () => {
    const editor = open([{ type: 'paragraph', content: 'pressed', props: { quoted: true } }]);

    insertBelow(editor, editor.document[0] as never, PICK);

    const blocks = editor.document as unknown as Read[];
    expect(blocks.slice(1).map((b) => b.props['quoted'])).toEqual([true, true]);
  });

  it('makes the other entries as the menu always has', () => {
    const editor = open([{ type: 'paragraph', content: 'pressed' }]);

    insertBelow(editor, editor.document[0] as never, 'heading-2');
    insertBelow(editor, editor.document[0] as never, 'divider');

    expect((editor.document as unknown as Read[]).map((b) => b.type)).toEqual([
      'paragraph',
      'divider',
      'paragraph',
      'heading',
    ]);
  });
});

/**
 * A pending image block as a pick brings it in.
 * @param uploadId - Its upload.
 * @returns The block.
 */
function pendingImage(uploadId: string): unknown {
  return { type: 'image', props: { url: '', uploadId, name: `${uploadId}.png` } };
}

/**
 * The document as types, with each line's text, children nested.
 * @param blocks - Blocks to describe.
 * @returns One entry per block.
 */
function kinds(blocks: readonly unknown[]): unknown[] {
  return (blocks as Seen[]).map((block) => {
    const label = block.type === 'paragraph' ? (block.content ?? []).map((c) => c.text ?? '').join('') : block.type;
    const kids = block.children ?? [];
    return kids.length > 0 ? [label, kinds(kids)] : label;
  });
}

describe('the media a pick brings in (inner#1351 + inner#1390 design §5.9)', () => {
  it('lands under the pressed row with the empty line after it, quoted as that row, caret in the line', () => {
    const editor = open([
      { type: 'paragraph', props: { quoted: true }, content: 'pressed' },
      { type: 'paragraph', content: 'after' },
    ]);

    insertMediaBelow(editor, editor.document[0] as never, [pendingImage('u1'), pendingImage('u2')] as never);

    const blocks = editor.document as Seen[];
    expect(kinds(blocks)).toEqual(['pressed', 'image', 'image', '', 'after']);
    expect(blocks.slice(1, 4).map((b) => b.props?.['quoted'])).toEqual([true, true, true]);
    expect((editor.getTextCursorPosition().block as { id: string }).id).toBe(blocks[3]!.id);
  });

  it('lands before the pressed row\'s children', () => {
    const editor = open([
      { type: 'paragraph', content: 'parent', children: [{ type: 'paragraph', content: 'child' }] },
    ]);

    insertMediaBelow(editor, editor.document[0] as never, [pendingImage('u1')] as never);

    expect(kinds(editor.document)).toEqual([['parent', ['image', '', 'child']]]);
  });

  it('with its empty line is one undo step', () => {
    const doc = new Y.Doc();
    const { manager, extension } = createDocumentUndo(doc);
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'pressed' }] as never);
    manager.stopCapturing();

    insertMediaBelow(editor, editor.document[0] as never, [pendingImage('u1')] as never);
    manager.undo();

    expect(kinds(editor.document)).toEqual(['pressed']);
  });

  it.each([
    ['below a row', 0, insertMediaBelow],
    ['on an empty line', 1, insertMediaOnRow],
  ] as const)('%s is an undo step apart from typing just before it', (_where, row, insert) => {
    const doc = new Y.Doc();
    const { manager, extension } = createDocumentUndo(doc);
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'pressed' }, { type: 'paragraph' }] as never);
    manager.clear();
    editor.setTextCursorPosition((editor.document as Seen[])[0]!.id!, 'end');
    editor.insertInlineContent(' typed');

    insert(editor, (editor.document as Seen[])[row] as never, [pendingImage('u1')] as never);
    manager.undo();

    expect(kinds(editor.document)).toEqual(['pressed typed', '']);
  });

  it('on an empty line lands above it, quoted as that line, and leaves the caret in it', () => {
    const editor = open([
      { type: 'paragraph', content: 'above' },
      { type: 'paragraph', props: { quoted: true } },
    ]);
    const line = (editor.document as Seen[])[1]!;

    insertMediaOnRow(editor, line as never, [pendingImage('u1')] as never);

    const blocks = editor.document as Seen[];
    expect(kinds(blocks)).toEqual(['above', 'image', '']);
    expect(blocks[1]!.props?.['quoted']).toBe(true);
    expect((editor.getTextCursorPosition().block as { id: string }).id).toBe(line.id);
  });
});
