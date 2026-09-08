// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 浮出条 spec（2026-08-19）的对齐槽位: which selections it draws itself live for.
 *
 * Alignment reaches the block types that carry a line of text the reader sets
 * the edge of, and nothing else. What the slot does when pressed is #905; what
 * it looks like now is this, and the answer has to come from the flat model —
 * the same question asked of the nested one walked outwards through list and
 * quote ancestors, and those ancestors are gone.
 *
 * One alignable block is enough, so the selection spanning two kinds is the
 * case that separates "some" from "every".
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { selectionCanAlign } from '@web/spaces/document/document-align-model';

type DocumentEditor = ReturnType<typeof buildDocumentEditor>;

const mounted: DocumentEditor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * A mounted document holding the given blocks.
 * @param blocks - The body, in BlockNote's own shape.
 * @returns The editor.
 */
function open(blocks: readonly Record<string, unknown>[]): DocumentEditor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Selects everything from the first character to the last.
 * @param editor - The editor.
 */
function selectAllText(editor: DocumentEditor): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(doc, 1, doc.content.size - 1),
    ),
  );
}

/**
 * Puts the caret in the first block.
 * @param editor - The editor.
 */
function caretInFirstBlock(editor: DocumentEditor): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)),
  );
}

describe('which selections alignment reaches', () => {
  it('reaches a paragraph', () => {
    const editor = open([{ type: 'paragraph', content: 'plain words' }]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(true);
  });

  it('reaches a heading', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'a heading' },
    ]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(true);
  });

  it('reaches a quoted paragraph, quote taking no part in the question', () => {
    const editor = open([
      { type: 'paragraph', props: { quoted: true }, content: 'quoted words' },
    ]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(true);
  });

  it('does not reach a bullet list item', () => {
    const editor = open([{ type: 'bulletListItem', content: 'an item' }]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(false);
  });

  it('does not reach a numbered list item', () => {
    const editor = open([{ type: 'numberedListItem', content: 'an item' }]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(false);
  });

  it('does not reach a task list item', () => {
    const editor = open([{ type: 'checkListItem', content: 'a task' }]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(false);
  });

  it('does not reach a code block', () => {
    const editor = open([{ type: 'codeBlock', content: 'npm install' }]);
    caretInFirstBlock(editor);

    expect(selectionCanAlign(editor)).toBe(false);
  });

  it('reaches a selection running from a heading into a code block', () => {
    // One alignable block is enough: pressing it still moves the heading, so
    // the control is live rather than grey.
    const editor = open([
      { type: 'heading', props: { level: 1 }, content: 'a heading' },
      { type: 'codeBlock', content: 'npm i' },
    ]);
    selectAllText(editor);

    expect(selectionCanAlign(editor)).toBe(true);
  });

  it('does not reach a selection holding only list items and code', () => {
    const editor = open([
      { type: 'bulletListItem', content: 'an item' },
      { type: 'codeBlock', content: 'npm i' },
    ]);
    selectAllText(editor);

    expect(selectionCanAlign(editor)).toBe(false);
  });
});
