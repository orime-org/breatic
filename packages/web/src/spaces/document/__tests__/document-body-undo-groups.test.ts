// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

const opened: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    for (const close of opened.splice(0).reverse()) close();
    cleanupCodecFixtures();
  });
});

/** Mounts the production records binding over three lines. @throws {Error} If setup fails. */
function open(): { editor: ReturnType<typeof buildDocumentEditor>; undo: ReturnType<typeof createDocumentUndo> } {
  const doc = codecFixture([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }, { id: 'g', text: 'gamma' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    body: { document: 'records-undo-groups', runtime, history: undo.manager, origin },
    extensions: [undo.extension],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => { editor.mount(host); });
  opened.push(() => { editor.unmount(); runtime.dispose(); undo.manager.destroy(); host.remove(); });
  undo.manager.clear();
  return { editor, undo };
}

/** Reads the lines joined in order. @throws {never} */
function lines(editor: ReturnType<typeof buildDocumentEditor>): string {
  const words: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => { if (node.type.name === 'paragraph') words.push(node.textContent); });
  return words.join('|');
}

/**
 * Types at the end of the line holding the given words, as consecutive keystrokes.
 * @param editor - The mounted editor.
 * @param line - The words of the line to type at.
 * @param text - The characters typed.
 * @throws {Error} If the line is absent.
 */
function typeAtEnd(editor: ReturnType<typeof buildDocumentEditor>, line: string, text: string): void {
  const view = editor.prosemirrorView!;
  let end = -1;
  view.state.doc.descendants((node, pos) => { if (node.type.name === 'paragraph' && node.textContent === line) end = pos + 1 + node.content.size; });
  if (end < 0) throw new Error(`No line ${line}`);
  act(() => { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end))); });
  for (const character of text) act(() => { view.dispatch(view.state.tr.insertText(character)); });
}

describe('undo steps of the records body history', () => {
  it('keeps a block move right after typing as its own undo step', () => {
    const { editor } = open();
    typeAtEnd(editor, 'gamma', '!');
    act(() => { editor.setTextCursorPosition('a'); editor.moveBlocksDown(); editor.moveBlocksDown(); });
    expect(lines(editor)).toBe('beta|gamma!|alpha');

    act(() => { editor.undo(); });

    expect(lines(editor)).toBe('alpha|beta|gamma!');
  });

  it('keeps consecutive keystrokes in one line as one undo step', () => {
    const { editor } = open();
    typeAtEnd(editor, 'beta', ' max');

    act(() => { editor.undo(); });

    expect(lines(editor)).toBe('alpha|beta|gamma');
  });
});
