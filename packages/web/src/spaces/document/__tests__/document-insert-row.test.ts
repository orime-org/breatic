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
  mediaGapBelow,
  mediaGapOnRow,
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

describe('the gap a media pick uploads into (inner#1127 A1)', () => {
  it('makes the empty line under the pressed row at once, caret in it, and goes above that line', () => {
    const editor = open([
      { type: 'paragraph', props: { quoted: true }, content: 'pressed' },
      { type: 'paragraph', content: 'after' },
    ]);

    const gap = mediaGapBelow(editor, editor.document[0] as never);

    const blocks = editor.document as Seen[];
    expect(shape(blocks)).toEqual(['pressed', '', 'after']);
    expect(blocks[1]!.props?.['quoted']).toBe(true);
    expect((editor.getTextCursorPosition().block as { id: string }).id).toBe(blocks[1]!.id);
    expect(gap).toEqual({
      anchor: { before: blocks[0]!.id, after: blocks[1]!.id },
      quoted: true,
    });
  });

  it('makes that line before the pressed row\'s children, which is where the media goes', () => {
    const editor = open([
      {
        type: 'paragraph',
        content: 'parent',
        children: [{ type: 'paragraph', content: 'child' }],
      },
    ]);

    const gap = mediaGapBelow(editor, editor.document[0] as never);

    const kids = (editor.document as Seen[])[0]!.children!;
    expect(shape(kids)).toEqual(['', 'child']);
    expect(gap.anchor).toEqual({
      before: null,
      after: kids[0]!.id,
    });
  });

  it('on an empty line goes above it and leaves the caret in it', () => {
    const editor = open([
      { type: 'paragraph', content: 'above' },
      { type: 'paragraph', props: { quoted: true } },
    ]);
    const blocks = editor.document as Seen[];

    const gap = mediaGapOnRow(editor, blocks[1] as never);

    expect(shape(editor.document)).toEqual(['above', '']);
    expect((editor.getTextCursorPosition().block as { id: string }).id).toBe(blocks[1]!.id);
    expect(gap).toEqual({
      anchor: { before: blocks[0]!.id, after: blocks[1]!.id },
      quoted: true,
    });
  });

  it('on an empty first line has nothing before it', () => {
    const editor = open([{ type: 'paragraph' }]);

    const gap = mediaGapOnRow(editor, editor.document[0] as never);

    expect(gap.anchor.before).toBeNull();
  });
});
