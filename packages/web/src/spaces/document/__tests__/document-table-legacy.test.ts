// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T8, design section 4: a stored table from before cells held
 * blocks, met in a document collab has not converted yet. It shows, its
 * words can be edited, and nothing that acts on tables reaches it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { addRowAfter, isInTable } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/** A stored table, written the way documents from before hold one. */
const STORED = {
  type: 'table',
  content: { type: 'tableContent', rows: [{ cells: ['old a', 'old b'] }, { cells: ['old c', 'old d'] }] },
};

/**
 * A mounted editor holding a stored table and a new one.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  // A block before it, so a Tab that reached the block handling would indent
  // the whole table under it.
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'lead' },
    STORED,
    tableBlock({ rows: [{ cells: ['new a', 'new b'] }] }),
  ] as never);
  return editor;
}

/**
 * Puts the caret after some words.
 * @param editor - The editor.
 * @param words - The words.
 */
function caretAfter(editor: Editor, words: string): void {
  const view = editor.prosemirrorView;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === words) at = pos + words.length;
    return at < 0;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

/**
 * Presses a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @param shift - Whether Shift is held.
 */
function press(editor: Editor, key: string, shift = false): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
}

describe('a stored table in a document not converted yet', () => {
  it('shows its words in a table', () => {
    open();
    const stored = document.querySelector('[data-content-type="table"] table');
    expect(stored?.textContent).toContain('old a');
    expect(stored?.querySelectorAll('td')).toHaveLength(4);
  });

  it('takes typing in its cells', () => {
    const editor = open();
    caretAfter(editor, 'old a');
    editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.insertText('!'));
    expect(editor.prosemirrorState.doc.textContent).toContain('old a!');
  });

  it.each([false, true])('breaks the line in its cell on Enter (shift: %s), and keeps its shape', (shift) => {
    const editor = open();
    caretAfter(editor, 'old a');
    const before = editor.prosemirrorState.doc.child(0).child(1).childCount;

    expect(() => press(editor, 'Enter', shift)).not.toThrow();

    const stored = editor.prosemirrorState.doc.child(0).child(1).firstChild!;
    expect(stored.type.name).toBe('table');
    expect(editor.prosemirrorState.doc.child(0).child(1).childCount).toBe(before);
    expect(stored.firstChild!.firstChild!.firstChild!.lastChild?.type.name).toBe('hardBreak');
  });

  it.each([false, true])('does nothing on Tab (shift: %s)', (shift) => {
    const editor = open();
    caretAfter(editor, 'old a');
    const before = editor.prosemirrorState.doc;

    expect(() => press(editor, 'Tab', shift)).not.toThrow();

    expect(editor.prosemirrorState.doc.eq(before)).toBe(true);
  });

  it('is no table to the table plugin: its commands act on the new table only', () => {
    const editor = open();
    caretAfter(editor, 'old a');
    expect(isInTable(editor.prosemirrorState)).toBe(false);
    expect(addRowAfter(editor.prosemirrorState)).toBe(false);

    caretAfter(editor, 'new a');
    expect(isInTable(editor.prosemirrorState)).toBe(true);
  });

  it('writes out as Markdown beside a new table without throwing', () => {
    const editor = open();
    let markdown = '';
    expect(() => {
      markdown = blocksMarkdown(editor, editor.document as never);
    }).not.toThrow();
    expect(markdown).toContain('old a');
    expect(markdown).toContain('| new a | new b |');
  });
});
