// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The editor chrome: toolbar + body. The editor and its history come from the
 * container, so these tests drive real ones through the real user path — no
 * test-only hooks into the component.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  render,
  renderHook,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@breatic/shared';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import {
  useDocumentHistory,
  type DocumentHistoryState,
} from '@web/spaces/document/use-document-history';

/** Reads a fragment's plain text, paragraphs joined by a newline. */
function textOf(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/g, ''))
    .join('\n');
}

/** Reads a fragment with its markup, so marks are visible. */
function markupOf(fragment: Y.XmlFragment): string {
  return fragment.toArray().map((n) => n.toString()).join('');
}


describe('DocumentEditor', () => {
  const NAME = 'project-p/document-chrome';
  let doc: Y.Doc;
  let awareness: Awareness;
  let fragment: Y.XmlFragment;
  let editor: Editor;
  let history: DocumentHistoryState;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    fragment = documentBodyFragment(doc);
    const caretProvider = { awareness };
    const { result } = renderHook(() => {
      const handle = useDocumentEditor({
        doc,
        name: NAME,
        caretProvider,
      });
      return { handle, history: useDocumentHistory(handle?.undoManager ?? null) };
    });
    await waitFor(() => expect(result.current.handle).not.toBeNull());
    editor = result.current.handle!.editor;
    history = result.current.history;
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('顶部横条不存在：一个 doc-toolbar-tool-* 都渲染不出来', () => {
    // 横条整条去掉（user 2026-08-21 拍定，任务 #129）。用前缀查而不是逐个点名，
    // 是因为要断言的是「一个都没有」，点名只能证明点到的那几个没有。
    // 这里仍然传 history，是为了让今天那条横条真的渲染出来 —— 不传它组件会崩，
    // 那样红灯红在崩溃上，证明不了横条还在。横条删掉后这个参数一起去掉。
    render(<DocumentEditor editor={editor} history={history} />);
    expect(
      document.querySelectorAll('[data-testid^="doc-toolbar-tool-"]'),
    ).toHaveLength(0);
  });

  it('renders the toolbar and the editor body', () => {
    render(<DocumentEditor editor={editor} history={history} />);
    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
  });

  it('disables undo and redo while there is nothing on the stack', () => {
    render(<DocumentEditor editor={editor} history={history} />);
    expect(screen.getByTestId('doc-toolbar-tool-undo')).toBeDisabled();
    expect(screen.getByTestId('doc-toolbar-tool-redo')).toBeDisabled();
  });

  it('adds undo and redo to the toolbar, and changes nothing else about it', () => {
    // This slice makes the document collaborative, and undo comes with that:
    // history lives in the shared undo manager, and a document people edit
    // together without an undo is not shippable. The formatting controls
    // belong to the editing feature set — a separate slice — so WHAT they do
    // is untouched; three things about HOW changed, and `DocumentToolbar`
    // lists them (disabled for a viewer, subscribed state, translated labels).
    //
    // Asserted as the whole set rather than one membership check per button, so
    // a control quietly added or removed fails instead of slipping through the
    // gap between two positive assertions.
    render(<DocumentEditor editor={editor} history={history} />);
    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-toolbar-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-toolbar-tool-', ''));

    expect(ids.sort()).toEqual([
      'bold',
      'bullet-list',
      'italic',
      'ordered-list',
      'quote',
      'redo',
      'strike',
      'undo',
    ]);
  });

  describe('read-only (viewer)', () => {
    it('disables every control rather than hiding the toolbar', () => {
      // Every control, found by the same query the set assertion above uses —
      // a hard-coded list here would silently stop covering whatever gets added
      // next, and a viewer is exactly who must not reach a new control first.
      render(<DocumentEditor editor={editor} history={history} readOnly />);
      const controls = Array.from(
        document.querySelectorAll('[data-testid^="doc-toolbar-tool-"]'),
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control).toBeDisabled();
      }
    });

    it('does not let a viewer change the shared document from the toolbar', async () => {
      act(() => {
        editor.commands.setContent('<p>viewer text</p>');
      });
      await waitFor(() => expect(textOf(fragment)).toContain('viewer text'));
      const before = markupOf(fragment);

      render(<DocumentEditor editor={editor} history={history} readOnly />);
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 7 });
        screen.getByTestId('doc-toolbar-tool-bold').click();
      });

      // Making the body non-editable only stops typing; a toolbar command is a
      // programmatic dispatch and would go straight through it, writing into
      // the shared document that the server will then refuse — leaving this
      // viewer looking at a private fork.
      expect(markupOf(fragment)).toBe(before);
    });
  });
});
