// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where typing a trigger opens the slash menu, and when the menu counts as
 * open (inner#1125 A1, A6, design 5.1).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { SLASH_TRIGGERS, slashMayOpen, slashMenuShown } from '@web/spaces/document/document-slash-trigger';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

/**
 * An editor whose only block holds `text`, the caret after `caretAt`
 * characters of it.
 */
function caretIn(text: string, caretAt: number, type = 'paragraph'): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type, content: text }] as never);
  const id = (editor.document as unknown as { id: string }[])[0]?.id ?? '';
  editor.setTextCursorPosition(id, 'start');
  const view = editor.prosemirrorView;
  const start = view.state.selection.from;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + caretAt)));
  return editor;
}

describe('the slash menu triggers', () => {
  it('are the slash, the full-width slash and the ideographic comma', () => {
    expect([...SLASH_TRIGGERS]).toEqual(['/', '／', '、']);
  });
});

describe('where a trigger may open the menu', () => {
  it('opens at the start of a line', () => {
    expect(slashMayOpen(caretIn('', 0).prosemirrorView.state.tr)).toBe(true);
    expect(slashMayOpen(caretIn('words', 0).prosemirrorView.state.tr)).toBe(true);
  });

  it('opens after a space, a tab or a full-width space', () => {
    expect(slashMayOpen(caretIn('and ', 4).prosemirrorView.state.tr)).toBe(true);
    expect(slashMayOpen(caretIn('and\t', 4).prosemirrorView.state.tr)).toBe(true);
    expect(slashMayOpen(caretIn('中文　', 3).prosemirrorView.state.tr)).toBe(true);
  });

  it('opens at the start of a line made by Shift+Enter', () => {
    expect(slashMayOpen(caretIn('abc\n', 4).prosemirrorView.state.tr)).toBe(true);
  });

  it('stays closed inside a word, a date or "and/or"', () => {
    expect(slashMayOpen(caretIn('and', 3).prosemirrorView.state.tr)).toBe(false);
    expect(slashMayOpen(caretIn('11', 2).prosemirrorView.state.tr)).toBe(false);
    expect(slashMayOpen(caretIn('苹果', 2).prosemirrorView.state.tr)).toBe(false);
  });

  it('reads a selection the trigger replaces by what stands before it', () => {
    const select = (text: string, start: number, end: number): boolean => {
      const view = caretIn(text, 0).prosemirrorView;
      const from = view.state.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + start, from + end)));
      return slashMayOpen(view.state.tr);
    };
    expect(select('words', 0, 3)).toBe(true);
    expect(select('say hello', 4, 9)).toBe(true);
    expect(select('words', 2, 4)).toBe(false);
  });

  it('stays closed while the whole document is selected', () => {
    const view = caretIn('words', 0).prosemirrorView;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(slashMayOpen(view.state.tr)).toBe(false);
  });
});

describe('whether the menu counts as shown', () => {
  it('needs the extension to show it and the trigger to be one of ours', () => {
    expect(slashMenuShown({ show: true, triggerCharacter: '/' })).toBe(true);
    expect(slashMenuShown({ show: true, triggerCharacter: '、' })).toBe(true);
    expect(slashMenuShown({ show: false, triggerCharacter: '/' })).toBe(false);
    expect(slashMenuShown({ show: true, triggerCharacter: ':' })).toBe(false);
    expect(slashMenuShown(undefined)).toBe(false);
  });
});
