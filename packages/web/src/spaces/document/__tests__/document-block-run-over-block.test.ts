// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A5 and A6: a block type chosen off the block handle acts on
 * the row the pointer is over.
 *
 * The bubble bar's form of the same command reads the reader's selection. The
 * handle's form reads a row instead — one the reader has not selected and may
 * not even be near — so two things have to hold: nothing indented under that
 * row changes, and the reader's own caret comes back where it was.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { runBlockType } from '@web/spaces/document/document-block-run';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface Seen {
  readonly id: string;
  readonly type: string;
  readonly children?: readonly Seen[];
}

/**
 * Opens an editor holding a parent with two children, and a row after it.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'bulletListItem',
      content: 'parent',
      children: [
        { type: 'bulletListItem', content: 'first child' },
        { type: 'bulletListItem', content: 'second child' },
      ],
    },
    { type: 'paragraph', content: 'elsewhere' },
  ] as never);
  return editor;
}

describe('a block type chosen off the block handle', () => {
  it('changes the row it was chosen on', () => {
    const editor = open();
    const parent = editor.document[0] as unknown as Seen;

    runBlockType(editor, 'heading-2', parent.id);

    const after = editor.document[0] as unknown as Seen;
    expect(after.type).toBe('heading');
  });

  it('leaves everything indented under that row alone', () => {
    const editor = open();
    const parent = editor.document[0] as unknown as Seen;

    runBlockType(editor, 'heading-2', parent.id);

    const kids = (editor.document[0] as unknown as Seen).children ?? [];
    expect(kids.map((kid) => kid.type)).toEqual([
      'bulletListItem',
      'bulletListItem',
    ]);
  });

  it('leaves the reader’s caret where it was', () => {
    const editor = open();
    const parent = editor.document[0] as unknown as Seen;
    const elsewhere = editor.document[1] as unknown as Seen;
    editor.setTextCursorPosition(elsewhere.id, 'end');
    const before = editor.prosemirrorState.selection.from;

    runBlockType(editor, 'heading-2', parent.id);

    const where = editor.getTextCursorPosition().block as unknown as Seen;
    expect(where.id).toBe(elsewhere.id);
    expect(editor.prosemirrorState.selection.from).toBe(before);
  });

  it('acts on the selection when no row is named', () => {
    const editor = open();
    const elsewhere = editor.document[1] as unknown as Seen;
    editor.setTextCursorPosition(elsewhere.id, 'end');

    runBlockType(editor, 'heading-2');

    expect((editor.document[0] as unknown as Seen).type).toBe('bulletListItem');
    expect((editor.document[1] as unknown as Seen).type).toBe('heading');
  });
});
